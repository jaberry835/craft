import { useCallback } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import MainContent from './components/MainContent';
import ResizablePane from './components/ResizablePane';
import RequestWizard from './components/wizard/RequestWizard';
import PolicyIndex from './components/PolicyIndex';
import PolicyViewer from './components/PolicyViewer';
import { FormProvider } from './contexts/FormContext';
import type { RequestCategory } from './types/request';
import './App.css';

export default function App() {
  const navigate = useNavigate();

  const handleNavigate = useCallback((target: string) => {
    const printPages = ['business-cards', 'brochures', 'posters', 'branded-merch', 'stationery'];
    const digitalPages = ['social-media', 'web-assets', 'email-templates', 'presentations'];

    if (target === 'home') {
      navigate('/');
    } else if (target === 'policies') {
      navigate('/policies');
    } else if (target === 'brand-guidelines') {
      navigate('/policies/directive-925');
    } else if (printPages.includes(target)) {
      navigate('/wizard', { state: { initialCategory: 'print' as RequestCategory } });
    } else if (digitalPages.includes(target)) {
      navigate('/wizard', { state: { initialCategory: 'digital' as RequestCategory } });
    } else if (target === 'new-request') {
      navigate('/wizard');
    }
  }, [navigate]);

  return (
    <FormProvider>
    <div className="app-shell">
      <Navbar onNavigate={handleNavigate} />
      <div className="app-body">
        <Routes>
          <Route
            path="/"
            element={<MainContent onStartRequest={() => navigate('/wizard')} />}
          />
          <Route path="/wizard" element={<WizardPage onClose={() => navigate('/')} />} />
          <Route path="/policies" element={<PolicyIndex />} />
          <Route path="/policies/:policyId" element={<PolicyViewer />} />
        </Routes>
        <ResizablePane />
      </div>
    </div>
    </FormProvider>
  );
}

/** Thin wrapper so we can read router location state for initial category. */
function WizardPage({ onClose }: { onClose: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (window.history.state?.usr ?? {}) as any;
  const initialCategory: RequestCategory | undefined = state.initialCategory;
  return <RequestWizard initialCategory={initialCategory} onClose={onClose} />;
}
