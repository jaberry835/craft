import { describe, it, expect } from 'vitest';
import { buildCopilotCliLaunchSpec } from '../src/copilotCliSupport';

describe('buildCopilotCliLaunchSpec', () => {
    it('wraps resolved .cmd paths with cmd.exe on Windows', () => {
        const spec = buildCopilotCliLaunchSpec(
            'copilot',
            'C:\\Tools\\copilot.cmd',
            ['--model', 'gpt-4.1'],
            'win32',
            'C:\\Windows\\System32\\cmd.exe'
        );

        expect(spec.cliPath).toBe('C:\\Windows\\System32\\cmd.exe');
        expect(spec.cliArgs).toEqual(['/d', '/s', '/c', 'C:\\Tools\\copilot.cmd --model gpt-4.1']);
        expect(spec.resolvedCliPath).toBe('C:\\Tools\\copilot.cmd');
    });

    it('quotes spaced .cmd paths and arguments for cmd.exe', () => {
        const spec = buildCopilotCliLaunchSpec(
            'copilot',
            'C:\\Program Files\\GitHub Copilot\\copilot.cmd',
            ['--model', 'gpt 4.1'],
            'win32',
            'cmd.exe'
        );

        expect(spec.cliArgs).toEqual([
            '/d',
            '/s',
            '/c',
            '"C:\\Program Files\\GitHub Copilot\\copilot.cmd" --model "gpt 4.1"'
        ]);
    });

    it('keeps .exe launches direct on Windows', () => {
        const spec = buildCopilotCliLaunchSpec(
            'copilot',
            'C:\\Tools\\copilot.exe',
            ['--model', 'gpt-4.1'],
            'win32',
            'cmd.exe'
        );

        expect(spec).toEqual({
            cliPath: 'C:\\Tools\\copilot.exe',
            cliArgs: ['--model', 'gpt-4.1'],
            resolvedCliPath: 'C:\\Tools\\copilot.exe',
        });
    });

    it('keeps unresolved configured paths unchanged', () => {
        const spec = buildCopilotCliLaunchSpec(
            'copilot',
            undefined,
            ['--model', 'gpt-4.1'],
            'win32',
            'cmd.exe'
        );

        expect(spec).toEqual({
            cliPath: 'copilot',
            cliArgs: ['--model', 'gpt-4.1'],
            resolvedCliPath: undefined,
        });
    });
});