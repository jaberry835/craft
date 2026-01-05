import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { Message } from '../types/conversation';
import './MessageComponent.css';
import 'highlight.js/styles/github.css';

interface MessageComponentProps {
  message: Message;
}

const MessageComponent: React.FC<MessageComponentProps> = ({ message }) => {
  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  return (
    <div className={`message ${message.role.toLowerCase()}`}>
      <div className="message-header">
        <div className="message-info">
          <span className="handle">{message.handle}</span>
          <span className="role">{message.role}</span>
          <span className="timestamp">{formatTimestamp(message.timestamp)}</span>
        </div>
        <div className="message-meta">
          <span 
            className={`stage-badge stage-${message.query_type}`}
          >
            {message.query_type}
          </span>
          {message.coded_language && (
            <span className="coded-indicator" title="Uses coded language">
              🔒
            </span>
          )}
          {message.security_flags.encrypted && (
            <span className="encrypted-indicator" title="Encrypted communication">
              🛡️
            </span>
          )}
        </div>
      </div>
      
      <div className="message-content">
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight, rehypeRaw]}
          components={{
            // Custom components for better styling
            h1: ({ ...props }) => <h1 className="markdown-h1" {...props} />,
            h2: ({ ...props }) => <h2 className="markdown-h2" {...props} />,
            h3: ({ ...props }) => <h3 className="markdown-h3" {...props} />,
            h4: ({ ...props }) => <h4 className="markdown-h4" {...props} />,
            p: ({ ...props }) => <p className="markdown-p" {...props} />,
            ul: ({ ...props }) => <ul className="markdown-ul" {...props} />,
            ol: ({ ...props }) => <ol className="markdown-ol" {...props} />,
            blockquote: ({ ...props }) => <blockquote className="markdown-blockquote" {...props} />,
            code: ({ className, children, ...props }: any) => {
              const match = /language-(\w+)/.exec(className || '');
              const isInline = !props.node || props.node.tagName !== 'code' || !props.node.properties?.className;
              return !isInline && match ? (
                <pre className="markdown-code-block">
                  <code className={className} {...props}>
                    {children}
                  </code>
                </pre>
              ) : (
                <code className="markdown-inline-code" {...props}>
                  {children}
                </code>
              );
            },
            table: ({ ...props }) => (
              <div className="markdown-table-container">
                <table className="markdown-table" {...props} />
              </div>
            ),
            th: ({ ...props }) => <th className="markdown-th" {...props} />,
            td: ({ ...props }) => <td className="markdown-td" {...props} />,
            strong: ({ ...props }) => <strong className="markdown-strong" {...props} />,
            em: ({ ...props }) => <em className="markdown-em" {...props} />,
            a: ({ ...props }) => <a className="markdown-link" {...props} target="_blank" rel="noopener noreferrer" />,
          }}
        >
          {message.message}
        </ReactMarkdown>
      </div>
      
      {message.project_financials && (
        <div className="project-details">
          <h4>Project Financial Details:</h4>
          {message.project_financials.total_budget && (
            <p><strong>Total Budget:</strong> {message.project_financials.total_budget}</p>
          )}
          {message.project_financials.committed_amount && (
            <p><strong>Committed:</strong> {message.project_financials.committed_amount}</p>
          )}
          {message.project_financials.obligated_amount && (
            <p><strong>Obligated:</strong> {message.project_financials.obligated_amount}</p>
          )}
          {message.project_financials.expended_amount && (
            <p><strong>Expended:</strong> {message.project_financials.expended_amount}</p>
          )}
          {message.project_financials.remaining_budget && (
            <p><strong>Remaining:</strong> {message.project_financials.remaining_budget}</p>
          )}
          {message.project_financials.burn_rate && (
            <p><strong>Burn Rate:</strong> {message.project_financials.burn_rate}</p>
          )}
        </div>
      )}
    </div>
  );
};

export default MessageComponent;
