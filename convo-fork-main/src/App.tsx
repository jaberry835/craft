import React, { useState } from 'react';
import { Allotment } from 'allotment';
import ConversationPanel from './components/ConversationPanel';
import CopilotPanel from './components/CopilotPanel';
import { Message } from './types/conversation';
import {
  getInitialProjectInfo,
  getAssistantResponse,
  translateText
} from './services';
import 'allotment/dist/style.css';
import './App.css';

// Sample project list with WBS numbers
const projectOptions = [
  { id: 'PROJ-001', name: 'Defense Communications System', wbs: 'WBS-001' },
  { id: 'PROJ-002', name: 'Infrastructure Modernization', wbs: 'WBS-002' },
  { id: 'PROJ-003', name: 'Cybersecurity Enhancement', wbs: 'WBS-003' },
  { id: 'PROJ-004', name: 'Logistics Management System', wbs: 'WBS-004' },
  { id: 'PROJ-005', name: 'Training Platform Development', wbs: 'WBS-005' },
  { id: 'PROJ-006', name: 'Data Analytics Platform', wbs: 'WBS-006' },
  { id: 'PROJ-007', name: 'Emergency Response System', wbs: 'WBS-007' },
  { id: 'PROJ-008', name: 'Fleet Management Upgrade', wbs: 'WBS-008' },
  { id: 'PROJ-009', name: 'Facility Security Enhancement', wbs: 'WBS-009' },
  { id: 'PROJ-010', name: 'Network Infrastructure Upgrade', wbs: 'WBS-010' }
];

// Language options for communication
const languageOptions = ['English', 'Spanish', 'French', 'German'];

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isBotTyping, setIsBotTyping] = useState(false);
  // Language selection with default English
  const [selectedLanguage, setSelectedLanguage] = useState(languageOptions[0]);
  // Project selection
  const [selectedProject, setSelectedProject] = useState(projectOptions[0]);
  const [projectQuery, setProjectQuery] = useState('');
  const [started, setStarted] = useState(false);
  // Draft message state lifted for action insertion
  const [draftMessage, setDraftMessage] = useState('');

  const initiateConversation = async () => {
    if (!projectQuery.trim()) return;
    setMessages([]);
    setIsBotTyping(true);
    setStarted(true);
    const initialText = await getInitialProjectInfo(selectedProject.id, projectQuery);
    // Translate initial response if needed
    let displayInitialMsg = initialText;
    if (selectedLanguage !== 'English') {
      const native = await translateText(initialText, selectedLanguage);
      displayInitialMsg = `${native}\n\n(English: ${initialText})`;
    }
    const initialMsg: Message = {
      turn_order: 1,
      timestamp: new Date().toISOString(),
      role: 'User',
      handle: 'Government Officer',
      message: projectQuery,
      query_type: 'project_initiation',
      coded_language: false,
      security_flags: { encrypted: false, pgp_key_exchanged: false },
      project_financials: null
    };
    
    const assistantMsg: Message = {
      turn_order: 2,
      timestamp: new Date().toISOString(),
      role: 'Assistant',
      handle: 'Financial Assistant',
      message: displayInitialMsg,
      query_type: 'project_overview',
      coded_language: false,
      security_flags: { encrypted: false, pgp_key_exchanged: false },
      project_financials: null
    };
    
    setMessages([initialMsg, assistantMsg]);
    setIsBotTyping(false);
  };

  const handleSendMessage = async (messageText: string) => {
    // Determine query type based on message content
    const text = messageText.toLowerCase();
    const queryType = text.match(/\b(budget|spend|financial|cost)\b/) ? 'financial_query'
      : text.match(/\b(wbs|work breakdown|task)\b/) ? 'wbs_query'
      : text.match(/\b(personnel|staff|team)\b/) ? 'personnel_query'
      : text.match(/\b(timeline|schedule|milestone)\b/) ? 'timeline_query'
      : 'general_query';
    
    // Create and display user message
    let displayUser = messageText;
    if (selectedLanguage !== 'English') {
      const native = await translateText(messageText, selectedLanguage);
      displayUser = `${native}\n\n(English: ${messageText})`;
    }
    
    const newMessage: Message = {
      turn_order: messages.length + 1,
      timestamp: new Date().toISOString(),
      role: 'User',
      handle: 'Government Officer',
      message: displayUser,
      query_type: queryType,
      coded_language: false,
      security_flags: { encrypted: true, pgp_key_exchanged: true },
      project_financials: null
    };

    setMessages(prev => [...prev, newMessage]);
    setIsBotTyping(true);

    // Clear draft message after send
    setDraftMessage('');
    try {
      // Pass full conversation history including the new user message
      const history = [...messages, newMessage];
      const botReply = await getAssistantResponse(selectedProject.id, selectedProject.wbs, projectQuery, messageText, history);
      // Translate assistant's response
      let assistantDisplay = botReply;
      if (selectedLanguage !== 'English') {
        const native = await translateText(botReply, selectedLanguage);
        assistantDisplay = `${native}\n\n(English: ${botReply})`;
      }
      
      const assistantMessage: Message = {
        turn_order: messages.length + 2,
        timestamp: new Date().toISOString(),
        role: 'Assistant',
        handle: 'Financial Assistant',
        message: assistantDisplay,
        query_type: queryType,
        coded_language: false,
        security_flags: { encrypted: true, pgp_key_exchanged: true },
        project_financials: null
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error fetching assistant response:', error);
    } finally {
      setIsBotTyping(false);
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Government Contract Financial Assistant</h1>
        <button
          className="reset-btn"
          onClick={() => window.location.reload()}
        >
          New Session
        </button>
      </header>
      <div className="App-content">
        <Allotment defaultSizes={[60, 40]}>
          <Allotment.Pane minSize={300}>
            <ConversationPanel
              messages={messages}
              isBotTyping={isBotTyping}
              onSendMessage={handleSendMessage}
              started={started}
              draftMessage={draftMessage}
              setDraftMessage={setDraftMessage}
              assistantHandle="Financial Assistant"
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={250}>
            <CopilotPanel
                projectOptions={projectOptions}
                selectedProject={selectedProject}
                setSelectedProject={setSelectedProject}
                languageOptions={languageOptions}
                selectedLanguage={selectedLanguage}
                setSelectedLanguage={setSelectedLanguage}
                projectQuery={projectQuery}
                setProjectQuery={setProjectQuery}
                initiateConversation={initiateConversation}
                started={started}
                messages={messages}
                setDraftMessage={setDraftMessage}
               />
             </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  );
}

export default App;
