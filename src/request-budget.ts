import { ErrorCodes, EzClassifyError } from './errors';

/**
 * Whether an abort reason is an elapsed deadline rather than a cancellation.
 *
 * `AbortSignal.timeout()` aborts with a `TimeoutError`, so a signal built that
 * way means "the server took too long", not "the caller changed its mind". The
 * two failures belong to different parties and carry different codes.
 */
export function isDeadlineAbort(reason: unknown): boolean {
    return (
        typeof reason === 'object' &&
        reason !== null &&
        (reason as { name?: unknown }).name === 'TimeoutError'
    );
}

/**
 * The one deadline and cancellation boundary a request runs under.
 *
 * It opens before the first credential lookup and closes when the request
 * settles, so everything in between shares it: the token supplier, the
 * Context-token supplier, the transport, the response body, the `onAuthFailure`
 * hook and the single replay. A request can therefore never wait longer than
 * the client's `timeout`, whatever the caller-supplied code along the way
 * does.
 *
 * Closing it clears the timer and detaches the caller's signal. A caller that
 * reuses one signal across many requests would otherwise collect a listener per
 * call.
 */
export class RequestBudget {
    /** Aborts when the deadline fires or the caller cancels. */
    readonly signal: AbortSignal;
    private readonly _controller = new AbortController();
    private readonly _timer: ReturnType<typeof setTimeout>;
    private readonly _detach?: () => void;
    private _timedOut = false;

    /**
     * @param path - Request path, for the error a spent budget reports
     * @param timeoutMs - The client's request timeout
     * @param callerSignal - The caller's own signal, if it passed one
     */
    constructor(
        private readonly _path: string,
        private readonly _timeoutMs: number,
        callerSignal?: AbortSignal,
    ) {
        this.signal = this._controller.signal;
        if (callerSignal?.aborted) {
            this._controller.abort(callerSignal.reason);
        } else if (callerSignal) {
            const forward = (): void =>
                this._controller.abort(callerSignal.reason);
            callerSignal.addEventListener('abort', forward, { once: true });
            this._detach = (): void =>
                callerSignal.removeEventListener('abort', forward);
        }
        this._timer = setTimeout(() => {
            // A caller that already canceled keeps its ABORTED.
            if (this.signal.aborted) return;
            this._timedOut = true;
            this._controller.abort(
                new Error(
                    `Request to ${this._path} timed out after ${this._timeoutMs}ms`,
                ),
            );
        }, this._timeoutMs);
    }

    /** Release the timer and the caller's signal. Safe to call more than once. */
    close(): void {
        clearTimeout(this._timer);
        this._detach?.();
    }

    /**
     * Wait for caller-supplied work, but no longer than this budget allows.
     *
     * Once the budget is spent the request rejects with `TIMEOUT` or `ABORTED`
     * and stops waiting. The work itself cannot be canceled from here; it is
     * left to settle on its own, and nothing of the request stays reachable
     * from it.
     *
     * @param stage - What the request was waiting for, named in a `TIMEOUT`
     * @param start - Starts the work; not called when the budget is spent
     * @param describeFailure - Maps the work's own rejection, when it has one
     * @returns The work's result
     * @throws {EzClassifyError} `TIMEOUT` past the deadline, `ABORTED` when the
     *   caller canceled, or whatever `describeFailure` returns
     */
    async run<T>(
        stage: string | undefined,
        start: () => T | PromiseLike<T>,
        describeFailure?: (err: unknown) => unknown,
    ): Promise<T> {
        try {
            return await settleOnAbort(start, this.signal);
        } catch (err: unknown) {
            if (this.signal.aborted) throw this.expired(stage);
            throw describeFailure ? describeFailure(err) : err;
        }
    }

    /**
     * The error a spent budget reports.
     *
     * The client's own deadline and a caller signal built by
     * `AbortSignal.timeout()` are both an elapsed deadline, so both are
     * `TIMEOUT`. Anything else that aborted the signal is the caller
     * canceling.
     */
    expired(stage?: string): EzClassifyError {
        const waiting = stage ? ` waiting for ${stage}` : '';
        if (this._timedOut) {
            return new EzClassifyError(
                `Request to ${this._path} timed out after ${this._timeoutMs}ms${waiting}`,
                ErrorCodes.TIMEOUT,
            );
        }
        if (isDeadlineAbort(this.signal.reason)) {
            return new EzClassifyError(
                `Request to ${this._path} timed out: the deadline on its signal elapsed${waiting}`,
                ErrorCodes.TIMEOUT,
            );
        }
        return new EzClassifyError(
            `Request aborted: ${this._path}`,
            ErrorCodes.ABORTED,
        );
    }
}

/**
 * One request's hold on work that may never settle.
 *
 * The work's reactions reach only this object, and it drops the request's
 * resolvers and signal the moment either side decides. A promise the host keeps
 * pending forever therefore retains two empty references, not the request that
 * gave up on it.
 */
class AbortRace<T> {
    private _resolve: ((value: T) => void) | null;
    private _reject: ((reason: unknown) => void) | null;
    private _signal: AbortSignal | null;

    constructor(
        resolve: (value: T) => void,
        reject: (reason: unknown) => void,
        signal: AbortSignal,
    ) {
        this._resolve = resolve;
        this._reject = reject;
        this._signal = signal;
        signal.addEventListener('abort', this, { once: true });
    }

    /** The signal aborted first. */
    handleEvent(): void {
        this.reject(this._signal?.reason);
    }

    resolve(value: T): void {
        const resolve = this._resolve;
        this._release();
        resolve?.(value);
    }

    reject(reason: unknown): void {
        const reject = this._reject;
        this._release();
        reject?.(reason);
    }

    private _release(): void {
        this._signal?.removeEventListener('abort', this);
        this._resolve = null;
        this._reject = null;
        this._signal = null;
    }
}

/**
 * Settle with the work's outcome or with the signal's abort reason, whichever
 * comes first. Work is not started on a signal that has already aborted.
 */
function settleOnAbort<T>(
    start: () => T | PromiseLike<T>,
    signal: AbortSignal,
): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    let work: PromiseLike<T>;
    try {
        work = Promise.resolve(start());
    } catch (err: unknown) {
        return Promise.reject(err as Error);
    }
    return new Promise<T>((resolve, reject) => {
        const race = new AbortRace(resolve, reject, signal);
        observe(work, race);
        // Starting the work can itself abort the signal, and an abort that
        // already happened never reaches a listener added after it.
        if (signal.aborted) race.handleEvent();
    });
}

/**
 * Attach the race to the work. Kept apart from {@link settleOnAbort} so the
 * reactions close over the race alone and nothing else from the call.
 */
function observe<T>(work: PromiseLike<T>, race: AbortRace<T>): void {
    work.then(
        (value) => race.resolve(value),
        (reason: unknown) => race.reject(reason),
    );
}
