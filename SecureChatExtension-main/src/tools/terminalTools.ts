/**
 * Terminal tools — run_terminal_command, check_terminal_output.
 */
import * as cp from 'child_process';
import { ToolEntry, ToolContext } from './types';
import { detectNetworkEgress, scrubEnvForShell } from '../security';

export function createTerminalTools(ctx: ToolContext): ToolEntry[] {
    return [
        // ── run_terminal_command ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'run_terminal_command',
                    description: 'Execute a shell command in the workspace root and return stdout/stderr. Output is streamed live. Use for building, testing, installing packages, git operations, etc. Set background=true for long-running processes (dev servers, watchers) — returns a process ID you can check later with check_terminal_output.',
                    parameters: {
                        type: 'object',
                        properties: {
                            command: { type: 'string', description: 'The shell command to execute' },
                            cwd: { type: 'string', description: 'Optional working directory relative to workspace root' },
                            timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 30000). Use up to 120000 for slow builds. Ignored for background processes.' },
                            background: { type: 'boolean', description: 'If true, start the process in background and return immediately with a process ID. Use for dev servers, watchers, etc.' }
                        },
                        required: ['command']
                    }
                }
            },
            handler: async (args) => {
                const command = args.command as string;
                const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 30000, 5000), 120000);
                const background = args.background === true || args.background === 'true';

                // Block dangerous commands
                const dangerous: RegExp[] = [
                    /rm\s+.*-[a-z]*r[a-z]*f[^a-z]|rm\s+.*-[a-z]*f[a-z]*r[^a-z]/i,
                    /rm\s+.*\s+\/(?:\s|$)/,
                    /rm\s+.*~\//,
                    /rm\s+.*\$HOME/i,
                    /rm\s+.*\/\*/,
                    /find\s+\/\s+.*-delete/i,
                    /mkfs\./i,
                    /dd\s+.*of=\/dev\//i,
                    /chmod\s+.*-R\s+777\s+\//i,
                    /chown\s+.*-R\s+.*\s+\//i,
                    /:(){ :|:& };:/,
                    />\/dev\/sd[a-z]/i,
                    /format\s+[a-z]:/i,
                    /del\s+\/[sfq].*[a-z]:\\?$/i,
                    /del\s+\/[sfq].*\\\*/i,
                    /rd\s+\/[sq].*[a-z]:\\?$/i,
                    /rmdir\s+\/[sq].*[a-z]:\\?$/i,
                    /Remove-Item\s+.*-Recurse.*[\/\\]\s*$/i,
                    /Remove-Item\s+.*-Recurse.*[a-z]:\\?\s*$/i,
                    /Remove-Item\s+.*~[\/\\]?\s/i,
                    /Clear-Content\s+.*[a-z]:\\?\s*$/i,
                    /Stop-Computer/i,
                    /Restart-Computer/i,
                    /shutdown\s/i,
                    /reboot\b/i,
                    /init\s+0/,
                    /halt\b/i,
                ];
                for (const d of dangerous) {
                    if (d.test(command)) {
                        return { success: false, result: 'Command blocked — potentially destructive system-wide command.' };
                    }
                }

                const approved = await ctx.requestConfirmation(`Run command: ${command}${background ? ' (background)' : ''}`, 'terminal');
                if (!approved) { return { success: false, result: 'User declined the terminal command.' }; }

                // Phase-1 prompt-injection mitigation: any command that performs network
                // egress requires a SECOND, explicit confirmation that names the tool and
                // any URL/host fragments we extracted. This breaks the classic
                // "model reads poisoned file -> model curls attacker -> data exfil" chain
                // even when the user previously enabled session-level terminal approval.
                const egress = detectNetworkEgress(command);
                if (egress.detected) {
                    const targetSummary = egress.targets.length
                        ? ` to ${egress.targets.slice(0, 3).join(', ')}${egress.targets.length > 3 ? ', ...' : ''}`
                        : '';
                    const egressDesc = `Allow network egress via ${egress.tools.join('/')}${targetSummary}? Command: ${command}`;
                    const egressApproved = await ctx.requestConfirmation(egressDesc, 'terminal');
                    if (!egressApproved) { return { success: false, result: 'User declined the network-egress command.' }; }
                }

                const root = ctx.getWorkspaceRoot();
                const cwd = args.cwd ? ctx.validatePath(args.cwd as string) || root : root;
                const isWindows = process.platform === 'win32';
                const shell = isWindows ? 'cmd.exe' : '/bin/sh';
                const shellArgs = isWindows ? ['/c', command] : ['-c', command];

                // Phase-1 mitigation: strip secret-shaped env vars before spawning the
                // child shell so that `env` / `printenv` / `Get-ChildItem env:` cannot
                // leak inherited credentials back into the LLM context.
                const { env: scrubbedEnv } = scrubEnvForShell(process.env);

                const proc = cp.spawn(shell, shellArgs, {
                    cwd,
                    env: scrubbedEnv,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                if (background) {
                    // Clean up exited background processes before adding new ones
                    for (const [id, bg] of ctx.backgroundProcesses) {
                        if (bg.exited) { ctx.backgroundProcesses.delete(id); }
                    }

                    if (ctx.backgroundProcesses.size >= ctx.maxBackgroundProcesses) {
                        proc.kill();
                        return {
                            success: false,
                            result: `Too many background processes (limit: ${ctx.maxBackgroundProcesses}). Use check_terminal_output to review existing processes, or wait for some to finish.`
                        };
                    }

                    const procId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    const entry = { proc, output: [] as string[], command, startedAt: Date.now(), exited: false, exitCode: null as number | null };
                    ctx.backgroundProcesses.set(procId, entry);

                    const collectOutput = (data: Buffer) => {
                        const lines = data.toString().split('\n');
                        for (const line of lines) {
                            if (line.length > 0) {
                                entry.output.push(line);
                                if (entry.output.length > 500) { entry.output.shift(); }
                                if (ctx.callbacks.onTerminalOutput) { ctx.callbacks.onTerminalOutput(line); }
                            }
                        }
                    };

                    proc.stdout?.on('data', collectOutput);
                    proc.stderr?.on('data', collectOutput);
                    proc.on('close', (code) => {
                        entry.exited = true;
                        entry.exitCode = code;
                    });

                    return { success: true, result: `Background process started (ID: ${procId}). Use check_terminal_output with this ID to see output or check if it's still running.` };
                }

                // Foreground mode
                return new Promise((resolve) => {
                    const outputLines: string[] = [];
                    let killed = false;

                    const timer = setTimeout(() => {
                        killed = true;
                        proc.kill();
                    }, timeoutMs);

                    const collectLine = (data: Buffer) => {
                        const lines = data.toString().split('\n');
                        for (const line of lines) {
                            if (line.length > 0) {
                                outputLines.push(line);
                                if (ctx.callbacks.onTerminalOutput) { ctx.callbacks.onTerminalOutput(line); }
                            }
                        }
                    };

                    proc.stdout?.on('data', collectLine);
                    proc.stderr?.on('data', collectLine);

                    proc.on('close', (code) => {
                        clearTimeout(timer);
                        let output = outputLines.join('\n');

                        if (output.length > 30000) {
                            output = output.slice(0, 30000) + '\n... [output truncated]';
                        }

                        if (killed && output) {
                            resolve({
                                success: true,
                                result: output + `\n\n⚠ Command timed out after ${timeoutMs / 1000}s but produced output above.`
                            });
                        } else {
                            resolve({
                                success: code === 0,
                                result: output || '(no output)'
                            });
                        }
                    });

                    proc.on('error', (err) => {
                        clearTimeout(timer);
                        resolve({ success: false, result: `Failed to start process: ${err.message}` });
                    });
                });
            }
        },

        // ── check_terminal_output ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'check_terminal_output',
                    description: 'Check the output and status of a background terminal process started with run_terminal_command(background=true). Returns recent output lines and whether the process is still running.',
                    parameters: {
                        type: 'object',
                        properties: {
                            process_id: { type: 'string', description: 'The process ID returned by run_terminal_command in background mode' },
                            tail: { type: 'number', description: 'Number of recent output lines to return (default 50, max 200)' },
                            kill: { type: 'boolean', description: 'If true, kill the background process' }
                        },
                        required: ['process_id']
                    }
                }
            },
            handler: async (args) => {
                const procId = args.process_id as string;
                const tail = Math.min(Math.max(Number(args.tail) || 50, 1), 200);
                const shouldKill = args.kill === true || args.kill === 'true';

                const entry = ctx.backgroundProcesses.get(procId);
                if (!entry) {
                    const available = Array.from(ctx.backgroundProcesses.keys());
                    return { success: false, result: `No background process with ID "${procId}".${available.length > 0 ? ' Available: ' + available.join(', ') : ''}` };
                }

                if (shouldKill && !entry.exited) {
                    entry.proc.kill();
                    return { success: true, result: `Process ${procId} killed.` };
                }

                const lines = entry.output.slice(-tail);
                const status = entry.exited
                    ? `Exited with code ${entry.exitCode}`
                    : `Running (${Math.round((Date.now() - entry.startedAt) / 1000)}s)`;
                const output = lines.length > 0 ? lines.join('\n') : '(no output yet)';

                return { success: true, result: `[${status}] Command: ${entry.command}\n\n${output}` };
            }
        },
    ];
}
