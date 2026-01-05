import React, { useState, useMemo } from 'react';
import { Suggestion, Message } from '../types/conversation';
import {
  getPatternAnalysisSuggestions,
  retrieveContext
} from '../services';
import SuggestionCard from './SuggestionCard';
import './CopilotPanel.css';

interface CopilotPanelProps {
  projectOptions: Array<{id: string; name: string; wbs: string}>;
  selectedProject: {id: string; name: string; wbs: string};
  setSelectedProject: React.Dispatch<React.SetStateAction<{id: string; name: string; wbs: string}>>;
  languageOptions: string[];
  selectedLanguage: string;
  setSelectedLanguage: React.Dispatch<React.SetStateAction<string>>;
  projectQuery: string;
  setProjectQuery: React.Dispatch<React.SetStateAction<string>>;
  initiateConversation: () => Promise<void>;
  started: boolean;
  messages: Message[];
  setDraftMessage: React.Dispatch<React.SetStateAction<string>>;
}

const CopilotPanel: React.FC<CopilotPanelProps> = ({
  projectOptions,
  selectedProject,
  setSelectedProject,
  languageOptions,
  selectedLanguage,
  setSelectedLanguage,
  projectQuery,
  setProjectQuery,
  initiateConversation,
  started,
  messages,
  setDraftMessage
}) => {
  const [patternSuggestions, setPatternSuggestions] = useState<Suggestion[]>([]);
  const [patternLoading, setPatternLoading] = useState(false);
  const [patternError, setPatternError] = useState<string>('');

  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<string[]>([]);
  const [detailError, setDetailError] = useState('');
  const [activeSuggestion, setActiveSuggestion] = useState<Suggestion | null>(null);

  const financialSummary = useMemo(() => {
    const budgetRegex = /\$([0-9,]+(?:\.[0-9]+)?)/g;
    let totalBudget = 0;
    let totalSpent = 0;
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const matches = msg.message.match(budgetRegex);
      if (matches) {
        matches.forEach(match => {
          const amount = parseFloat(match.replace('$', '').replace(/,/g, ''));
          if (msg.message.toLowerCase().includes('budget')) {
            totalBudget += amount;
          } else if (msg.message.toLowerCase().includes('spent')) {
            totalSpent += amount;
          }
        });
      }
    }
    
    if (totalBudget > 0) {
      const remaining = totalBudget - totalSpent;
      const percentSpent = ((totalSpent / totalBudget) * 100).toFixed(1);
      return `Budget: $${totalBudget.toLocaleString()} | Spent: $${totalSpent.toLocaleString()} (${percentSpent}%) | Remaining: $${remaining.toLocaleString()}`;
    }
    return '';
  }, [messages]);

  const handleRefreshFinancialAnalysis = () => {
    setPatternError('');
    setPatternLoading(true);
    getPatternAnalysisSuggestions(messages)
      .then((s: Suggestion[]) => setPatternSuggestions(s))
      .catch((err: any) => {
        console.error('Financial analysis fetch error:', err);
        setPatternSuggestions([]);
        setPatternError(err?.message || 'Error fetching financial analysis.');
      })
      .finally(() => setPatternLoading(false));
  };

  const handleGetDetails = async (suggestion: Suggestion) => {
    setActiveSuggestion(suggestion);
    setDetailError('');
    setDetailLoading(true);
    setDetailData([]);
    setDetailModalOpen(true);
    try {
      const snippets = await retrieveContext(`${suggestion.title}. ${suggestion.content}`);
      if (snippets.length > 0) {
        setDetailData(snippets);
      } else {
        setDetailError('No similar project data found for this suggestion.');
      }
    } catch (err: any) {
      console.error('Error loading details:', err);
      setDetailError(err?.message || 'Error loading details.');
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="copilot-panel">
      <div className="copilot-header">
        <h2>Financial Analysis Assistant</h2>
        <button 
          className="refresh-btn"
          onClick={handleRefreshFinancialAnalysis}
          disabled={!started || patternLoading}
        >
          {patternLoading ? 'Analyzing Financials...' : 'Refresh Analysis'}
        </button>
      </div>

      {detailModalOpen && (
        <div className="details-modal-overlay">
          <div className="details-modal">
            <button className="modal-close" onClick={() => setDetailModalOpen(false)}>✖</button>
            <h3>Details from similar project data</h3>
            {detailLoading && <p>Loading details...</p>}
            {detailError && <p className="error-msg">{detailError}</p>}
            {!detailLoading && !detailError && (
              detailData.length > 0 ? (
                <ul className="details-list">
                  {detailData.map((ctx, idx) => {
                    let docObj: Record<string, any>;
                    try { 
                      docObj = JSON.parse(ctx); 
                    } catch { 
                      docObj = { raw: ctx }; 
                    }
                    return (
                      <li key={idx} className="details-item">
                        {Object.entries(docObj).map(([key, value]) => (
                          <div key={key} className="details-field">
                            <strong>{key}:</strong>{' '}
                            <span className="details-value">
                              {typeof value === 'string' ? value : JSON.stringify(value)}
                            </span>
                          </div>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>No similar project data found for this suggestion.</p>
              )
            )}
          </div>
        </div>
      )}

      {financialSummary && (
        <div className="financial-summary-display">
          <strong>Financial Summary:</strong> {financialSummary}
        </div>
      )}

      {!started && (
        <div className="initiation-controls">
          <select
            aria-label="Select project"
            value={selectedProject.id}
            onChange={e => {
              const project = projectOptions.find(p => p.id === e.target.value);
              if (project) setSelectedProject(project);
            }}
          >
            {projectOptions.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.wbs})
              </option>
            ))}
          </select>
          <select
            aria-label="Select language"
            value={selectedLanguage}
            onChange={e => setSelectedLanguage(e.target.value)}
          >
            {languageOptions.map(lang => <option key={lang} value={lang}>{lang}</option>)}
          </select>
          <textarea
            placeholder="Enter your query about the project (e.g., 'Show me the budget breakdown for this project')"
            value={projectQuery}
            onChange={e => setProjectQuery(e.target.value)}
            rows={3}
          />
          <button
            className="initiate-btn"
            onClick={initiateConversation}
            disabled={!projectQuery.trim()}
          >
            Start Analysis
          </button>
        </div>
      )}

      {!started ? (
        <div className="initiation-placeholder">
          Start a project analysis to see AI-powered financial insights and recommendations.
        </div>
      ) : (
        <>
          <div className="analysis-status">
            <div className="status-indicator">
              <span className={`status-dot ${patternLoading ? 'analyzing' : 'ready'}`}></span>
              {patternLoading ? 'Analyzing financials...' : 'Financial analysis complete'}
            </div>
          </div>

          <div className="suggestions-section">
            <h3>Financial Analysis & Recommendations</h3>
            {patternError && <p className="error-msg">{patternError}</p>}
            {patternLoading && <p>Loading analysis...</p>}
            {!patternLoading && !patternError && patternSuggestions.length > 0 && (
              <div className="suggestions-grid">
                {patternSuggestions.map((suggestion, idx) => (
                  <SuggestionCard
                    key={`${suggestion.id}-${idx}`}
                    suggestion={suggestion}
                    onGetDetails={handleGetDetails}
                    onSelectSuggestion={setDraftMessage}
                  />
                ))}
              </div>
            )}
            {!patternLoading && !patternError && patternSuggestions.length === 0 && (
              <p>No financial analysis suggestions available at this time.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default CopilotPanel;
