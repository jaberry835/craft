declare module "mailcomposer" {
  interface MailComposerMessage {
    build(callback: (error: Error | null, message: Buffer) => void): void;
  }

  interface MailComposerAttachment {
    filename?: string;
    content?: string | Buffer | Uint8Array;
    contentType?: string;
  }

  export interface MailComposerOptions {
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    date?: Date;
    text?: string;
    html?: string;
    attachments?: MailComposerAttachment[];
  }

  export default function MailComposer(options?: MailComposerOptions): MailComposerMessage;
}