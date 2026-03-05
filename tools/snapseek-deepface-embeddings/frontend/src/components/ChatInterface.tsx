import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useChat } from '../hooks/useApi';
import type { ChatMessage, ChatImageReference } from '../types';

interface ChatInterfaceProps {
  onImageClick?: (imageId: string) => void;
}

interface DisplayMessage extends ChatMessage {
  images?: ChatImageReference[];
}

export function ChatInterface({ onImageClick }: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm SnapSeek, your intelligent image search assistant. Ask me anything about your image collection, and I'll help you find what you're looking for!",
    },
  ]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMutation = useChat();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || chatMutation.isPending) return;

    const userMessage = input.trim();
    setInput('');

    // Add user message
    const newUserMessage: DisplayMessage = { role: 'user', content: userMessage };
    setMessages((prev) => [...prev, newUserMessage]);

    try {
      // Build history (excluding images for API call)
      const history: ChatMessage[] = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await chatMutation.mutateAsync({
        message: userMessage,
        history,
        include_images: true,
      });

      // Add assistant message with images
      const assistantMessage: DisplayMessage = {
        role: 'assistant',
        content: response.message,
        images: response.images,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      // Add error message
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: "I'm sorry, I encountered an error. Please try again.",
        },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-xl overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message, index) => (
          <MessageBubble
            key={index}
            message={message}
            onImageClick={onImageClick}
          />
        ))}
        
        {chatMutation.isPending && (
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Searching...</span>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-700 p-4">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your images..."
            rows={1}
            className="flex-1 resize-none bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            style={{ minHeight: '48px', maxHeight: '120px' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || chatMutation.isPending}
            className="p-3 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-xl text-white transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: DisplayMessage;
  onImageClick?: (imageId: string) => void;
}

function MessageBubble({ message, onImageClick }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isUser ? 'bg-primary-600' : 'bg-purple-600'
        }`}
      >
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-white" />
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 max-w-[80%] ${isUser ? 'text-right' : ''}`}>
        <div
          className={`inline-block px-4 py-3 rounded-2xl ${
            isUser
              ? 'bg-primary-600 text-white rounded-br-md'
              : 'bg-slate-800 text-gray-200 rounded-bl-md'
          }`}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>

        {/* Images */}
        {message.images && message.images.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.images.map((img) => (
              <button
                key={img.id}
                onClick={() => onImageClick?.(img.id)}
                className="group relative w-24 h-24 rounded-lg overflow-hidden bg-slate-800 hover:ring-2 hover:ring-primary-500 transition-all"
              >
                {img.file_url ? (
                  <img
                    src={img.file_url}
                    alt={img.caption || img.filename}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageIcon className="w-8 h-8 text-gray-600" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <span className="text-xs text-white text-center px-1">
                    {img.filename}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
