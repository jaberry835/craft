import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import {
    getConfiguredCaCertificate,
    getConfiguredTlsOptions,
    isTlsCertificateError,
    resetNetworkStateForTests,
    setNetworkLogger,
} from '../src/network';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (settingPath: string) => values[settingPath],
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }));
}

describe('network CA certificate settings', () => {
    let tempDir: string;
    let logs: string[];

    beforeEach(() => {
        vi.clearAllMocks();
        resetNetworkStateForTests();
        logs = [];
        setNetworkLogger((msg) => logs.push(msg));
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-network-'));
        setConfiguration({});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('does nothing when junior.network.caCertPath is not configured', () => {
        expect(getConfiguredCaCertificate()).toBeUndefined();
        expect(getConfiguredTlsOptions()).toEqual({});
        expect(logs).toEqual([]);
    });

    it('loads the configured PEM file once and appends it to TLS trust options', () => {
        const pemPath = path.join(tempDir, 'enterprise-chain.pem');
        const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
        fs.writeFileSync(pemPath, pem, 'utf8');
        setConfiguration({ 'network.caCertPath': pemPath });

        expect(getConfiguredCaCertificate()).toBe(pem);
        expect(getConfiguredTlsOptions().ca).toContain(pem);
        // Calling again should not log a second "Loaded additional CA" line.
        expect(getConfiguredCaCertificate()).toBe(pem);
        const loadLogs = logs.filter((m) => m.startsWith('Loaded additional CA'));
        expect(loadLogs).toHaveLength(1);
        expect(loadLogs[0]).toContain(pemPath);
    });

    it('degrades gracefully and warns once when the configured PEM file is missing', () => {
        const pemPath = path.join(tempDir, 'missing.pem');
        setConfiguration({ 'network.caCertPath': pemPath });

        expect(getConfiguredCaCertificate()).toBeUndefined();
        expect(getConfiguredTlsOptions()).toEqual({});
        // Repeated calls should not spam the log.
        expect(getConfiguredCaCertificate()).toBeUndefined();
        const warnings = logs.filter((m) => m.includes('could not be read'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(pemPath);
    });

    it('detects certificate validation errors that can be recovered by refreshing the CA bundle', () => {
        expect(isTlsCertificateError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'certificate rejected' })).toBe(true);
        expect(isTlsCertificateError(new Error('unable to verify the first certificate'))).toBe(true);
        expect(isTlsCertificateError(new Error('socket hang up'))).toBe(false);
    });
});
