import { useParams, Link, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPolicyById, POLICIES } from '../data/policies';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import type { Components } from 'react-markdown';
import './PolicyViewer.css';

/** Turn a markdown heading string into a section-x-x style id. */
function headingToId(text: string): string {
  // Match leading numbering like "2.1" or "4.2.3"
  const m = text.match(/^(\d+(?:\.\d+)*)/);
  if (m) return 'section-' + m[1].replace(/\./g, '-');
  // Fallback: slugify
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Extract plain text from React children recursively. */
function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (children != null && typeof children === 'object') {
    const el = children as unknown as { props?: { children?: React.ReactNode } };
    if (el.props?.children != null) {
      return childrenToText(el.props.children);
    }
  }
  return '';
}

interface TocEntry {
  id: string;
  text: string;
  level: number;
}

function buildToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const re = /^(#{1,4})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown))) {
    const level = match[1].length;
    const text = match[2].trim();
    entries.push({ id: headingToId(text), text, level });
  }
  return entries;
}

export default function PolicyViewer() {
  const { policyId } = useParams<{ policyId: string }>();
  const location = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);

  const policy = policyId ? getPolicyById(policyId) : undefined;

  // Scroll to hash anchor after render
  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    // Small delay to allow markdown to render
    const timer = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(timer);
  }, [location.hash, policy]);

  if (!policy) {
    return (
      <div className="policy-viewer policy-not-found">
        <h2>Policy Not Found</h2>
        <p>The directive you're looking for doesn't exist.</p>
        <Link to="/policies" className="pv-back">
          <ArrowLeft size={16} /> Back to Directives
        </Link>
      </div>
    );
  }

  const toc = buildToc(policy.content);

  // Determine previous / next policies for navigation
  const idx = POLICIES.findIndex((p) => p.id === policy.id);
  const prev = idx > 0 ? POLICIES[idx - 1] : undefined;
  const next = idx < POLICIES.length - 1 ? POLICIES[idx + 1] : undefined;

  // Custom renderers for headings to inject anchor IDs
  const components: Partial<Components> = {
    h1: ({ children, ...rest }) => {
      const id = headingToId(childrenToText(children));
      return (
        <h1 id={id} {...rest}>
          <a href={`#${id}`} className="heading-anchor" aria-hidden="true">
            #
          </a>
          {children}
        </h1>
      );
    },
    h2: ({ children, ...rest }) => {
      const id = headingToId(childrenToText(children));
      return (
        <h2 id={id} {...rest}>
          <a href={`#${id}`} className="heading-anchor" aria-hidden="true">
            #
          </a>
          {children}
        </h2>
      );
    },
    h3: ({ children, ...rest }) => {
      const id = headingToId(childrenToText(children));
      return (
        <h3 id={id} {...rest}>
          <a href={`#${id}`} className="heading-anchor" aria-hidden="true">
            #
          </a>
          {children}
        </h3>
      );
    },
    h4: ({ children, ...rest }) => {
      const id = headingToId(childrenToText(children));
      return (
        <h4 id={id} {...rest}>
          <a href={`#${id}`} className="heading-anchor" aria-hidden="true">
            #
          </a>
          {children}
        </h4>
      );
    },
    // Open external links in new tab
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
  };

  return (
    <div className="policy-viewer">
      {/* Sidebar TOC */}
      <aside className="pv-sidebar">
        <Link to="/policies" className="pv-back">
          <ArrowLeft size={14} /> All Directives
        </Link>
        <nav className="pv-toc">
          {toc.map((entry) => (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              className={`pv-toc-item pv-toc-level-${entry.level}`}
            >
              {entry.text}
            </a>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <article className="pv-content" ref={contentRef}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {policy.content}
        </ReactMarkdown>

        {/* Prev / Next navigation */}
        <div className="pv-nav-footer">
          {prev ? (
            <Link to={`/policies/${prev.id}`} className="pv-nav-link pv-nav-prev">
              <ArrowLeft size={14} />
              <span>
                <small>Previous</small>
                Directive {prev.number}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={`/policies/${next.id}`} className="pv-nav-link pv-nav-next">
              <span>
                <small>Next</small>
                Directive {next.number}
              </span>
              <ChevronRight size={14} />
            </Link>
          ) : (
            <span />
          )}
        </div>
      </article>
    </div>
  );
}
