import { Printer, Sparkles, ArrowRight, Palette, Zap, Shield } from 'lucide-react';
import './MainContent.css';

interface Props {
  onStartRequest?: () => void;
}

export default function MainContent({ onStartRequest }: Props) {
  return (
    <div className="main-content">
      <div className="hero-section">
        <div className="hero-glow" />
        <div className="hero-inner">
          <div className="hero-badge">
            <Sparkles size={14} />
            <span>AI-Powered Design Studio</span>
          </div>
          <h1 className="hero-title">
            Create stunning<br />
            <span className="gradient-text">print & digital media</span>
          </h1>
          <p className="hero-subtitle">
            From business cards to social campaigns — request, track, and
            manage all your creative assets in one place.
          </p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={onStartRequest}>
              <span>Start a Request</span>
              <ArrowRight size={16} />
            </button>
            <button className="btn-secondary">
              Browse Templates
            </button>
          </div>
        </div>

        {/* Feature cards */}
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon purple">
              <Printer size={20} />
            </div>
            <h4>Print Media</h4>
            <p>Business cards, brochures, posters, banners & branded merchandise.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon blue">
              <Palette size={20} />
            </div>
            <h4>Digital Media</h4>
            <p>Social graphics, web assets, email templates & presentations.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon green">
              <Zap size={20} />
            </div>
            <h4>Fast Turnaround</h4>
            <p>AI-assisted workflows ensure rapid delivery on every project.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon orange">
              <Shield size={20} />
            </div>
            <h4>Brand Compliance</h4>
            <p>Automated checks keep every design on-brand and consistent.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
