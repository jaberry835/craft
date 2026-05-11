/**
 * Security utilities — Phase 1 prompt-injection / data-exfil mitigations.
 *
 * Three concerns are centralized here so all wire-level boundaries use the
 * same logic and so they are unit-testable in isolation:
 *
 *  1. wrapUntrusted()  — tag tool output as untrusted data (not instructions)
 *                        before it is pushed back into the LLM message stream.
 *  2. redactSecrets()  — strip high-confidence secret patterns from any
 *                        string that will be sent to the model or persisted
 *                        in the chat transcript.
 *  3. scrubEnvForShell() — drop secret-shaped env vars before spawning a
 *                        child shell so `printenv` / `env` cannot leak them.
 *  4. detectNetworkEgress() — flag commands that perform network egress so
 *                        the caller can require an extra explicit confirm.
 *
 * These are defense-in-depth; none of them is sufficient on its own.
 */

/**
 * Stable opaque markers that bracket every tool result on the wire.
 * Constants — NOT randomized — so the system prompt can reference them.
 */
export const UNTRUSTED_BEGIN = '<<<JUNIOR_UNTRUSTED_TOOL_OUTPUT>>>';
export const UNTRUSTED_END = '<<</JUNIOR_UNTRUSTED_TOOL_OUTPUT>>>';

/**
 * Strip any forged occurrence of our boundary markers from the body so a
 * malicious file/command cannot escape the untrusted region by emitting the
 * end marker followed by attacker-authored "instructions".
 */
function stripForgedMarkers(s: string): string {
    if (!s) { return s; }
    return s
        .replace(/<<<\/?JUNIOR_UNTRUSTED_TOOL_OUTPUT[^>]*>>>/g, '«marker stripped»');
}

/**
 * Wrap a tool result so the model receives it as clearly demarcated
 * untrusted data. The system prompt has a matching rule that tells the
 * model to treat content between these markers as data only.
 */
export function wrapUntrusted(toolName: string, body: string): string {
    const safeBody = stripForgedMarkers(redactSecrets(body ?? ''));
    return `${UNTRUSTED_BEGIN}\ntool=${toolName}\n${safeBody}\n${UNTRUSTED_END}`;
}

// ─── Secret redaction ──────────────────────────────────────────────────────

interface SecretPattern {
    name: string;
    regex: RegExp;
}

/**
 * High-confidence secret patterns. We deliberately avoid generic "long
 * random string" heuristics to minimize false positives. Each pattern
 * targets a known credential format.
 */
const SECRET_PATTERNS: SecretPattern[] = [
    // GitHub tokens
    { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
    // OpenAI API keys
    { name: 'openai-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
    // AWS access keys
    { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'aws-secret-key', regex: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
    // Slack tokens
    { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    // Google API keys
    { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    // Azure / generic shared-access-signature style
    { name: 'azure-sas', regex: /\bSharedAccessSignature\s+sr=[^&\s]+&sig=[A-Za-z0-9%+/=]{20,}/gi },
    // JWT (three base64url segments separated by dots, header begins with eyJ)
    { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    // Bearer tokens in HTTP-style headers
    { name: 'bearer', regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g },
    // PEM-encoded private keys (entire block)
    { name: 'pem-private-key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |PRIVATE)?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |PRIVATE)?PRIVATE KEY-----/g },
];

/**
 * Replace high-confidence secret patterns with `«redacted:type»` markers.
 * Conservative by design — false positives on user code are worse than
 * occasional misses on novel formats.
 */
export function redactSecrets(input: string): string {
    if (!input) { return input; }
    let out = input;
    for (const p of SECRET_PATTERNS) {
        out = out.replace(p.regex, `«redacted:${p.name}»`);
    }
    return out;
}

// ─── Env scrubbing ─────────────────────────────────────────────────────────

/**
 * Substring fragments that, if present in an env var name, indicate the
 * value is likely a secret. Matched case-insensitively.
 */
const SECRET_NAME_FRAGMENTS = [
    'TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL',
    'APIKEY', 'API_KEY', 'PRIVATE', 'SESSION', 'COOKIE', 'AUTH',
];

/**
 * Specific env var name prefixes we always strip. These are common cloud /
 * vendor prefixes whose values are nearly always secrets in dev environments.
 */
const SECRET_NAME_PREFIXES = [
    'AZURE_', 'AWS_', 'GCP_', 'GOOGLE_', 'GITHUB_', 'OPENAI_', 'ANTHROPIC_',
    'NPM_', 'PYPI_', 'DOCKER_', 'KUBE_', 'HEROKU_', 'STRIPE_', 'TWILIO_',
    'SLACK_', 'JUNIOR_', 'SECURECHAT_', 'COPILOT_',
];

/**
 * Env var names that should always pass through even though they match the
 * heuristics above. Without these, common shells and tooling break.
 */
const ENV_ALLOWLIST = new Set<string>([
    'PATH', 'PATHEXT', 'HOME', 'USER', 'USERNAME', 'USERPROFILE', 'LOGNAME',
    'SHELL', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'PWD', 'OLDPWD', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROGRAMDATA', 'APPDATA', 'LOCALAPPDATA', 'PUBLIC',
    'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH',
    'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM',
    'VSCODE_PID', 'VSCODE_CWD',
]);

/**
 * Return a copy of the env with secret-shaped variables removed.
 * The set of dropped names is intentionally aggressive — child shells
 * spawned by the agent should not have access to credentials inherited
 * from the developer's interactive session.
 */
export function scrubEnvForShell(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; dropped: string[] } {
    const out: NodeJS.ProcessEnv = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) { continue; }
        if (shouldStripEnvVar(k)) {
            dropped.push(k);
            continue;
        }
        out[k] = v;
    }
    return { env: out, dropped };
}

function shouldStripEnvVar(name: string): boolean {
    const upper = name.toUpperCase();
    if (ENV_ALLOWLIST.has(upper)) { return false; }
    for (const prefix of SECRET_NAME_PREFIXES) {
        if (upper.startsWith(prefix)) { return true; }
    }
    for (const frag of SECRET_NAME_FRAGMENTS) {
        if (upper.includes(frag)) { return true; }
    }
    return false;
}

// ─── Network egress detection ──────────────────────────────────────────────

/**
 * Patterns that indicate a shell command is making (or attempting) outbound
 * network requests. Matching is intentionally broad: false positives just
 * trigger one extra confirmation prompt; false negatives are the
 * exfiltration vector we are trying to close.
 */
const EGRESS_PATTERNS: { tool: string; regex: RegExp }[] = [
    { tool: 'curl', regex: /(?:^|[\s;&|`(])curl(\.exe)?\b/i },
    { tool: 'wget', regex: /(?:^|[\s;&|`(])wget(\.exe)?\b/i },
    { tool: 'Invoke-WebRequest', regex: /\bInvoke-WebRequest\b/i },
    { tool: 'Invoke-RestMethod', regex: /\bInvoke-RestMethod\b/i },
    { tool: 'iwr', regex: /(?:^|[\s;&|`(])iwr\b/i },
    { tool: 'irm', regex: /(?:^|[\s;&|`(])irm\b/i },
    { tool: 'Start-BitsTransfer', regex: /\bStart-BitsTransfer\b/i },
    { tool: 'bitsadmin', regex: /\bbitsadmin\b/i },
    { tool: 'nc', regex: /(?:^|[\s;&|`(])nc(at)?(\.exe)?\b/i },
    { tool: 'ssh', regex: /(?:^|[\s;&|`(])ssh\b/i },
    { tool: 'scp', regex: /(?:^|[\s;&|`(])scp\b/i },
    { tool: 'sftp', regex: /(?:^|[\s;&|`(])sftp\b/i },
    { tool: 'rsync', regex: /(?:^|[\s;&|`(])rsync\b/i },
    { tool: 'ftp', regex: /(?:^|[\s;&|`(])ftp\b/i },
    { tool: 'telnet', regex: /(?:^|[\s;&|`(])telnet\b/i },
];

/** Roughly extract URLs / host:port targets mentioned in the command. */
function extractEgressTargets(command: string): string[] {
    const targets = new Set<string>();
    const urlRe = /\bhttps?:\/\/[^\s'"`)]+/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(command)) !== null) {
        targets.add(m[0]);
    }
    // ssh/scp host:path style and bare host:port
    const hostRe = /\b(?<!\/)(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d{1,5})?\b/g;
    while ((m = hostRe.exec(command)) !== null) {
        if (!m[0].endsWith('.exe') && !m[0].endsWith('.ps1')) {
            targets.add(m[0]);
        }
    }
    return [...targets];
}

export interface EgressDetection {
    detected: boolean;
    tools: string[];
    targets: string[];
}

/**
 * Inspect a shell command for network-egress tool invocations.
 * Returns the matched tool names and any URL/host fragments found.
 */
export function detectNetworkEgress(command: string): EgressDetection {
    const tools: string[] = [];
    for (const p of EGRESS_PATTERNS) {
        if (p.regex.test(command)) { tools.push(p.tool); }
    }
    if (tools.length === 0) {
        return { detected: false, tools: [], targets: [] };
    }
    return { detected: true, tools, targets: extractEgressTargets(command) };
}
