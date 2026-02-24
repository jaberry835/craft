import { useRef, useCallback, useEffect, useState } from 'react';
import ChatPanel from './ChatPanel';
import './ResizablePane.css';

interface ResizablePaneProps {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

export default function ResizablePane({
  defaultWidth = 380,
  minWidth = 300,
  maxWidth = 600,
}: ResizablePaneProps) {
  const [width, setWidth] = useState(defaultWidth);
  const isResizing = useRef(false);
  const paneRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = window.innerWidth - e.clientX;
      setWidth(Math.min(maxWidth, Math.max(minWidth, newWidth)));
    };

    const onMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth, maxWidth]);

  return (
    <div className="resizable-pane" ref={paneRef} style={{ width }}>
      <div className="resize-handle" onMouseDown={onMouseDown}>
        <div className="resize-indicator" />
      </div>
      <div className="pane-content">
        <ChatPanel />
      </div>
    </div>
  );
}
