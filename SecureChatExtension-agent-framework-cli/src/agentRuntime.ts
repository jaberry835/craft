import { ChatMessage, ChatMode, ExtensionMessage, RuntimeSessionState } from './types';

export interface AgentCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

export interface AgentRuntime {
    isRunning(): boolean;
    getMessages(): ChatMessage[];
    setMessages(messages: ChatMessage[]): void;
    clearMessages(): void;
    cancel(): void;
    run(mode: ChatMode, text: string, images?: string[], files?: { name: string; content: string }[], displayText?: string): Promise<void>;
    resolveConfirmation?(actionId: string, approved: boolean, allowSession?: boolean): void;
    getSessionState?(): RuntimeSessionState | undefined;
    restoreSessionState?(state: RuntimeSessionState | undefined): Promise<void>;
    dispose?(): void;
}
