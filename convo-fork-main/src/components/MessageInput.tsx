import React, { useState } from 'react';
import './MessageInput.css';

interface MessageInputProps {
  onSendMessage: (message: string) => void;
  disabled?: boolean;
  value?: string;
  onChangeValue?: (value: string) => void;
}

const MessageInput: React.FC<MessageInputProps> = ({ onSendMessage, disabled = false, value, onChangeValue }) => {
  const [localMessage, setLocalMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const message = typeof value === 'string' ? value : localMessage;
  const setMessage = onChangeValue ?? setLocalMessage;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      setIsTyping(true);
      onSendMessage(message.trim());
      setMessage('');

      // Simulate typing delay
      setTimeout(() => {
        setIsTyping(false);
      }, 1000);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="message-input-container">
      <form onSubmit={handleSubmit} className="message-form">
        <div className="input-wrapper">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type your negotiation message..."
            className="message-textarea"
            rows={3}
            disabled={isTyping || disabled}
          />
          <button
            type="submit"
            className="send-button"
            disabled={!message.trim() || isTyping || disabled}
          >
            {isTyping ? (
              <div className="sending-indicator">
                <span className="spinner"></span>
                Sending...
              </div>
            ) : (
              <>
                <span>Send</span>
                <span className="send-icon">📤</span>
              </>
            )}
          </button>
        </div>
      </form>

      <div className="input-hints">
        <div className="security-status">
          <span className="security-icon">🔐</span>
          <span>Secure channel active</span>
        </div>
        <div className="input-tip">
          <span>Tip: Press Enter to send, Shift+Enter for new line</span>
        </div>
      </div>
    </div>
  );
};

export default MessageInput;
