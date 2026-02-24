import { useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, ExternalLink } from 'lucide-react';
import type { PolicyMeta } from '../data/policies';
import './PolicyModal.css';

interface PolicyModalProps {
  policy: PolicyMeta;
  hash?: string;           // e.g. "#section-2-1"
  onClose: () => void;
  onOpenTab: (path: string) => void;
}

export default function PolicyModal({ policy, hash, onClose, onOpenTab }: PolicyModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll to anchor after render
  useEffect(() => {
    if (!hash) return;
    const id = hash.replace('#', '');
    const timer = setTimeout(() => {
      const el = contentRef.current?.querySelector(`#${id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(timer);
  }, [hash, policy.id]);

  // Close on Escape
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const policyPath = `/policies/${policy.id}${hash ?? ''}`;

  /** Turn heading text into a section-x-x style id (same as PolicyViewer). */
  function headingToId(text: string): string {
    const m = text.match(/^(\d+(?:\.\d+)*)/);
    if (m) return 'section-' + m[1].replace(/\./g, '-');
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function childrenToText(children: React.ReactNode): string {
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) return children.map(childrenToText).join('');
    if (children != null && typeof children === 'object') {
      const el = children as unknown as { props?: { children?: React.ReactNode } };
      if (el.props?.children != null) return childrenToText(el.props.children);
    }
    return '';
  }

  const headingRenderer = (Tag: 'h1' | 'h2' | 'h3' | 'h4') =>
    ({ children, ...rest }: React.ComponentProps<typeof Tag>) => {
      const id = headingToId(childrenToText(children));
      return (
        <Tag id={id} {...rest}>
          <a href={`#${id}`} className="heading-anchor" aria-hidden="true">#</a>
          {children}
        </Tag>
      );
    };

  return (
    <div className="policy-modal-backdrop" onClick={handleBackdropClick}>
      <div className="policy-modal">
        <header className="policy-modal-header">
          <div className="policy-modal-title">
            <span className="policy-modal-icon">{policy.icon}</span>
            <h2>{policy.fullTitle}</h2>
          </div>
          <div className="policy-modal-actions">
            <button
              className="policy-modal-open-tab"
              onClick={() => onOpenTab(policyPath)}
              title="Open in main view"
            >
              <ExternalLink size={14} />
              Open
            </button>
            <button className="policy-modal-close" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="policy-modal-body" ref={contentRef}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: headingRenderer('h1'),
              h2: headingRenderer('h2'),
              h3: headingRenderer('h3'),
              h4: headingRenderer('h4'),
              a: ({ href, children, ...rest }) => {
                const isExternal = href && /^https?:\/\//.test(href);
                return (
                  <a
                    href={href}
                    {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    {...rest}
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {policy.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
