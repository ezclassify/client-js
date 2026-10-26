// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { load } from 'js-yaml';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * The vendor-readonly gate, executed rather than read.
 *
 * Every other assertion this repository makes about that workflow is a string
 * match on the YAML, and a string match cannot tell a control that fires from
 * one that is present and inert. An identity check that compared `%an` alone,
 * or a pull_request path that checked only who opened the PR, would both read
 * fine as text.
 *
 * So this harness lifts the two `run:` bodies out of the workflow file
 * verbatim, wires up the environment GitHub would give them, and runs them with
 * bash against a throwaway repository whose history is built to order. What is
 * asserted is the exit code and the output, the gate's actual behavior. Change
 * the workflow and these run against the change; there is no copy of the shell
 * here to drift.
 *
 * What this does NOT cover: GitHub's own event routing (which pushes trigger
 * the workflow at all), and `actions/checkout` (whether the commits are even
 * present in the runner's clone). Those are asserted textually in
 * vendor-spec-provenance.spec.ts. This file covers what the gate does once it
 * has a repository and an event.
 */
const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/vendor-readonly.yml');

const ZERO_SHA = '0000000000000000000000000000000000000000';

/** The step that resolves the commit range, by its `name:` in the workflow. */
const RANGE_STEP = 'Resolve the commit range this event introduced';
/** The step that runs the identity and subject gates. */
const GATE_STEP = 'Enforce bot identity + commit-subject for vendor/ commits';

interface WorkflowStep {
    name?: string;
    run?: string;
    env?: Record<string, string>;
}

interface Workflow {
    jobs: Record<string, { steps: WorkflowStep[] }>;
}

const workflow = load(readFileSync(WORKFLOW, 'utf8')) as Workflow;

/**
 * Pull one named `run:` step out of the workflow.
 *
 * @param name - The step's `name:` value.
 * @returns Its script body and its declared `env` block.
 */
function step(name: string): { run: string; env: Record<string, string> } {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const found = steps.find((candidate) => candidate.name === name);
    if (!found?.run) {
        throw new Error(
            `vendor-readonly.yml has no run step named ${JSON.stringify(name)}. ` +
                `This harness executes the workflow's own script bodies, so a ` +
                `renamed step must be renamed here too rather than silently ` +
                `leaving the gate untested.`,
        );
    }
    return { run: found.run, env: found.env ?? {} };
}

/** A `${{ ... }}` value: supplied per scenario, not taken from the file. */
const EXPRESSION = /^\s*\$\{\{[\s\S]*\}\}\s*$/;

/**
 * Build a step's environment the way the runner would.
 *
 * Literal values are read out of the workflow, so the bot login and email the
 * gate compares against are the real ones and a wrong value in the file fails a
 * scenario here. Expression values are the event's, and every one of them has
 * to be supplied: an unsupplied expression would reach bash as an empty string
 * and quietly change what the scenario tested.
 *
 * @param declared - The step's `env:` block from the workflow.
 * @param supplied - Values for the `${{ }}` keys, by env-var name.
 * @returns The environment to hand bash.
 */
function environment(
    declared: Record<string, string>,
    supplied: Record<string, string>,
): Record<string, string> {
    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    for (const [key, value] of Object.entries(declared)) {
        if (!EXPRESSION.test(String(value))) {
            resolved[key] = String(value);
            continue;
        }
        if (!(key in supplied)) {
            missing.push(key);
            continue;
        }
        resolved[key] = supplied[key];
    }
    if (missing.length > 0) {
        throw new Error(
            `The workflow reads ${missing.join(', ')} from the event, and this ` +
                `harness supplies no value. Add it to the scenario inputs; an ` +
                `empty string would test something other than what GitHub runs.`,
        );
    }
    return resolved;
}

interface StepResult {
    status: number;
    output: string;
}

/**
 * Run a script body with bash, capturing exit status and combined output.
 *
 * @param body - The shell script.
 * @param cwd - Working directory, i.e. the checkout the gate inspects.
 * @param env - Environment for the step.
 * @returns Exit status and everything it printed.
 */
function bash(
    body: string,
    cwd: string,
    env: Record<string, string>,
): StepResult {
    try {
        const output = execFileSync('bash', ['-c', body], {
            cwd,
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH ?? '',
                HOME: process.env.HOME ?? '',
                ...env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, output };
    } catch (error) {
        const failure = error as {
            status?: number;
            stdout?: string;
            stderr?: string;
        };
        return {
            status: failure.status ?? 1,
            output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
        };
    }
}

interface Event {
    EVENT_NAME: string;
    PR_BASE_SHA?: string;
    PR_HEAD_SHA?: string;
    PUSH_BEFORE?: string;
    PUSH_AFTER?: string;
    PUSH_FORCED?: string;
    DEFAULT_BRANCH?: string;
    PR_AUTHOR?: string;
    PR_LABELS?: string;
}

/**
 * Run both workflow steps in order, passing the first's outputs to the second
 * exactly as `steps.range.outputs.*` does.
 *
 * @param repo - The repository the gate inspects.
 * @param event - The event fields GitHub would expose.
 * @returns Each step's status and output.
 */
function runGate(
    repo: string,
    event: Event,
): { range: StepResult; gate: StepResult } {
    const outputFile = path.join(
        mkdtempSync(path.join(tmpdir(), 'ghout-')),
        'out',
    );
    writeFileSync(outputFile, '');

    const rangeStep = step(RANGE_STEP);
    const range = bash(rangeStep.run, repo, {
        ...environment(rangeStep.env, {
            EVENT_NAME: event.EVENT_NAME,
            PR_BASE_SHA: event.PR_BASE_SHA ?? '',
            PR_HEAD_SHA: event.PR_HEAD_SHA ?? '',
            PUSH_BEFORE: event.PUSH_BEFORE ?? '',
            PUSH_AFTER: event.PUSH_AFTER ?? '',
            PUSH_FORCED: event.PUSH_FORCED ?? 'false',
            DEFAULT_BRANCH: event.DEFAULT_BRANCH ?? 'main',
        }),
        GITHUB_OUTPUT: outputFile,
    });

    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
    }

    const gateStep = step(GATE_STEP);
    const gate = bash(
        gateStep.run,
        repo,
        environment(gateStep.env, {
            EVENT_NAME: event.EVENT_NAME,
            RANGE_MODE: outputs.mode ?? '',
            BASE_SHA: outputs.base ?? '',
            HEAD_SHA: outputs.head ?? '',
            PR_AUTHOR: event.PR_AUTHOR ?? '',
            PR_LABELS: event.PR_LABELS ?? '',
        }),
    );

    return { range, gate };
}

/** The identity the spec bot commits under. */
const BOT_NAME = 'ezclassify-spec-bot[bot]';
const BOT_EMAIL = 'ezclassify-spec-bot[bot]@users.noreply.github.com';

let scratch: string;

/**
 * Create an empty repository with a deterministic default branch.
 *
 * @param name - Directory name under the scratch root.
 * @returns Absolute path of the repository.
 */
function newRepo(name: string): string {
    const repo = path.join(scratch, name);
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    return repo;
}

/**
 * Write files and commit them under a chosen author identity.
 *
 * The author is set through the environment rather than `git config`, which is
 * the point of the forged-identity scenario: a name and an email are both just
 * headers a client chooses.
 *
 * @param repo - Repository path.
 * @param options - Author identity, subject line, and files to write.
 * @returns The new commit's SHA.
 */
function commit(
    repo: string,
    options: {
        name: string;
        email: string;
        subject: string;
        files: Record<string, string>;
    },
): string {
    for (const [relative, contents] of Object.entries(options.files)) {
        const file = path.join(repo, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents);
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', options.subject], {
        cwd: repo,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: options.name,
            GIT_AUTHOR_EMAIL: options.email,
            GIT_COMMITTER_NAME: options.name,
            GIT_COMMITTER_EMAIL: options.email,
        },
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
    }).trim();
}

/**
 * A commit that changes nothing under vendor/, to sit under the interesting
 * one.
 *
 * @param repo - Repository path.
 * @param label - Distinguishes successive base commits.
 * @returns The commit SHA.
 */
function baseCommit(repo: string, label = 'base'): string {
    return commit(repo, {
        name: 'A Maintainer',
        email: 'maintainer@example.com',
        subject: `chore: ${label}`,
        files: { 'README.md': `${label}\n` },
    });
}

/** A vendored-spec change, as the spec bot would write it. */
const VENDOR_FILES = { 'vendor/spec/MANIFEST.json': '{"contractsSha":"x"}\n' };

beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'vendor-gate-'));
});

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe('vendor-readonly gate, executed', () => {
    it.each([
        [
            BOT_NAME,
            '348097708+ezclassify-spec-bot[bot]@users.noreply.github.com',
            0,
        ],
        [BOT_NAME, `348097709+${BOT_EMAIL}`, 1],
        [BOT_NAME, '348097708+other-bot[bot]@users.noreply.github.com', 1],
        [
            'Other Bot',
            '348097708+ezclassify-spec-bot[bot]@users.noreply.github.com',
            1,
        ],
    ])('checks GitHub squash identity %s <%s>', (name, email, expected) => {
        const repo = newRepo(`squash-${name}-${email}`);
        const before = baseCommit(repo);
        const head = commit(repo, {
            name: String(name),
            email: String(email),
            subject: 'chore(spec): vendor contracts@deadbeef (#9)',
            files: VENDOR_FILES,
        });
        const { range, gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: before,
            PUSH_AFTER: head,
        });
        expect(range.status, range.output).toBe(0);
        expect(gate.status, gate.output).toBe(expected);
    });

    it('admits a genuine bot commit pushed with a resolvable before', () => {
        const repo = newRepo('bot-normal-before');
        const before = baseCommit(repo);
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });

        const { range, gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: before,
            PUSH_AFTER: head,
        });

        expect(range.status, range.output).toBe(0);
        expect(gate.status, gate.output).toBe(0);
        expect(gate.output).toContain('pass identity + subject gates');
    });

    it('admits the same commit on a branch-creation push, where before is all zeros', () => {
        // The spec bot creates chore/spec-update-<sha> and pushes it, and
        // GitHub reports before=000... for that. A gate that
        // refuses the flow its own error message recommends gets switched off.
        const repo = newRepo('bot-zero-before');
        const before = baseCommit(repo);
        execFileSync(
            'git',
            ['update-ref', 'refs/remotes/origin/main', before],
            {
                cwd: repo,
            },
        );
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });

        const { range, gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: ZERO_SHA,
            PUSH_AFTER: head,
        });

        expect(range.status, range.output).toBe(0);
        expect(range.output).toContain('branch creation');
        expect(gate.status, gate.output).toBe(0);
        expect(gate.output).toContain('pass identity + subject gates');
    });

    it('refuses a commit that forges the bot NAME with any other email', () => {
        // `git -c user.name=` sets the author name from any machine; a gate
        // that read %an alone would admit this.
        const repo = newRepo('forged-email');
        const before = baseCommit(repo);
        const head = commit(repo, {
            name: BOT_NAME,
            email: 'mallory@evil.example',
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: before,
            PUSH_AFTER: head,
        });

        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain('not authored by the spec bot');
        expect(gate.output).toContain('mallory@evil.example');
    });

    it('refuses a commit that forges the bot EMAIL under any other name', () => {
        const repo = newRepo('forged-name');
        const before = baseCommit(repo);
        const head = commit(repo, {
            name: 'Definitely The Bot',
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: before,
            PUSH_AFTER: head,
        });

        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain('not authored by the spec bot');
    });

    it('admits a commit that forges BOTH halves, and carries any payload it likes', () => {
        // The gate's actual boundary, pinned so no comment can drift wider
        // than it. `%an` and `%ae` are free-text fields of the commit object,
        // set by whoever writes the commit; two `git config` lines and a
        // matching `-m` reproduce the whole authorized identity from any
        // machine, and the subject gate constrains a string the same author
        // chose. So the commit below sails through carrying `src/payload.ts`
        // alongside the vendored file.
        //
        // This is not a defect to fix in the shell. It is the reason the
        // workflow describes itself as an accident stop rather than an
        // authentication boundary. Authenticating the writer needs branch
        // protection on the vendored paths or required signature
        // verification, which are repository settings, not workflow steps. If
        // either is ever configured, this expectation is what should change.
        const repo = newRepo('forged-both-halves');
        const before = baseCommit(repo);
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor spec bundle from contracts@aaaaaaaa',
            files: {
                ...VENDOR_FILES,
                'src/payload.ts': 'export const anything = 1;\n',
            },
        });

        const pushed = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: before,
            PUSH_AFTER: head,
        }).gate;
        expect(pushed.status, pushed.output).toBe(0);

        const viaPr = runGate(repo, {
            EVENT_NAME: 'pull_request',
            PR_BASE_SHA: before,
            PR_HEAD_SHA: head,
            PR_AUTHOR: BOT_NAME,
        }).gate;
        expect(viaPr.status, viaPr.output).toBe(0);

        // Named explicitly so the scenario cannot be read as a vendored-file
        // change that happened to pass: unrelated source rode in with it.
        const touched = execFileSync(
            'git',
            ['diff-tree', '--no-commit-id', '--name-only', '-r', head],
            { cwd: repo, encoding: 'utf8' },
        );
        expect(touched).toContain('src/payload.ts');
    });

    it('refuses a human-authored vendor commit inside a bot-opened pull request', () => {
        // The PR-author layer passes here: the PR really was opened by the bot
        // login. Only the per-commit layer sees that the commit inside it was
        // not written by the bot.
        const repo = newRepo('bot-pr-human-commit');
        const base = baseCommit(repo);
        const head = commit(repo, {
            name: 'A Maintainer',
            email: 'maintainer@example.com',
            subject: 'chore(spec): hand-edited, but it looks right',
            files: VENDOR_FILES,
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'pull_request',
            PR_BASE_SHA: base,
            PR_HEAD_SHA: head,
            PR_AUTHOR: BOT_NAME,
        });

        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain(
            'PR authored by ezclassify-spec-bot[bot]',
        );
        expect(gate.output).toContain('not authored by the spec bot');
    });

    it('admits a bot-authored commit inside a bot-opened pull request', () => {
        // The positive control for the scenario above: the per-commit layer is
        // a filter on authorship, not a blanket refusal of the PR path.
        const repo = newRepo('bot-pr-bot-commit');
        const base = baseCommit(repo);
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'pull_request',
            PR_BASE_SHA: base,
            PR_HEAD_SHA: head,
            PR_AUTHOR: BOT_NAME,
        });

        expect(gate.status, gate.output).toBe(0);
        expect(gate.output).toContain('pass identity + subject gates');
    });

    it('refuses a pull request opened by anyone but the bot', () => {
        const repo = newRepo('human-pr');
        const base = baseCommit(repo);
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'pull_request',
            PR_BASE_SHA: base,
            PR_HEAD_SHA: head,
            PR_AUTHOR: 'some-maintainer',
        });

        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain("authored by 'some-maintainer'");
    });

    it('lets the override label through on a pull request, and only there', () => {
        const repo = newRepo('override-label');
        const base = baseCommit(repo);
        const head = commit(repo, {
            name: 'A Maintainer',
            email: 'maintainer@example.com',
            subject: 'chore(spec): replace the mirror by hand',
            files: VENDOR_FILES,
        });

        const bypassed = runGate(repo, {
            EVENT_NAME: 'pull_request',
            PR_BASE_SHA: base,
            PR_HEAD_SHA: head,
            PR_AUTHOR: 'some-maintainer',
            PR_LABELS: 'spec-mirror-override',
        }).gate;
        expect(bypassed.status, bypassed.output).toBe(0);
        expect(bypassed.output).toContain('pull request only');

        // The same label text on a push is not a label at all: PR_LABELS is
        // empty there, so there is nothing for the bypass to match.
        const pushed = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: base,
            PUSH_AFTER: head,
        }).gate;
        expect(pushed.status, pushed.output).not.toBe(0);
        expect(pushed.output).toContain('not authored by the spec bot');
    });

    it('refuses a bot commit whose subject is not chore(spec):', () => {
        const repo = newRepo('bad-subject');
        const before = baseCommit(repo);
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject:
                'feat: quietly ship something else through the spec channel',
            files: VENDOR_FILES,
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: before,
            PUSH_AFTER: head,
        });

        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain('disallowed subject');
    });

    it('refuses rather than passes when the pushed range cannot be resolved', () => {
        // The push touched vendor/, which is the only reason the workflow
        // ran, but `before` is unusable and there is no origin/<default> to fall
        // back to, so the gate narrows to HEAD, and HEAD changed nothing under
        // vendor/. Exiting 0 here would be a green check that read no commits.
        const repo = newRepo('unresolvable-range');
        baseCommit(repo);
        commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });
        const head = baseCommit(repo, 'later work that does not touch vendor');

        const { range, gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: ZERO_SHA,
            PUSH_AFTER: head,
        });

        expect(range.status, range.output).toBe(0);
        expect(range.output).toContain('NOT INSPECTED');
        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain('Refusing to pass');
    });

    it('does not walk to an ancestor when it narrows to the head commit', () => {
        // `git log -1 <sha> -- vendor/` WALKS: given a head that changed
        // nothing under vendor/ it returns the nearest ancestor that did, so
        // the test for "did this commit touch vendor/" answers yes about a
        // commit that did not.
        //
        // The history below is built so that walking is the difference between
        // a refusal and a green check. HEAD is bot-authored with a
        // `chore(spec):` subject and touches nothing under vendor/; an
        // ancestor is the real vendor commit. With diff-tree the gate finds no
        // vendor commit it can read and refuses. With a walking log it decides
        // HEAD is a vendor commit, checks HEAD's identity and subject, finds
        // both immaculate, and passes, having never looked at the commit that
        // actually changed the vendored tree.
        const repo = newRepo('no-ancestor-walk');
        baseCommit(repo);
        commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): vendor contracts@abc1234',
            files: VENDOR_FILES,
        });
        const head = commit(repo, {
            name: BOT_NAME,
            email: BOT_EMAIL,
            subject: 'chore(spec): tidy the changelog, nothing under vendor',
            files: { 'CHANGELOG.md': 'nothing to do with vendor/\n' },
        });

        const { gate } = runGate(repo, {
            EVENT_NAME: 'push',
            PUSH_BEFORE: ZERO_SHA,
            PUSH_AFTER: head,
        });

        expect(gate.status, gate.output).not.toBe(0);
        expect(gate.output).toContain('Refusing to pass');
        expect(gate.output).not.toContain('pass identity + subject gates');
    });

    it('reports nothing to check only when a pull request genuinely carries no vendor commit', () => {
        const repo = newRepo('pr-no-vendor');
        const base = baseCommit(repo);
        const head = baseCommit(repo, 'ordinary change');

        const { gate } = runGate(repo, {
            EVENT_NAME: 'pull_request',
            PR_BASE_SHA: base,
            PR_HEAD_SHA: head,
            PR_AUTHOR: 'some-maintainer',
        });

        expect(gate.status, gate.output).toBe(0);
        expect(gate.output).toContain('nothing to check');
    });
});
