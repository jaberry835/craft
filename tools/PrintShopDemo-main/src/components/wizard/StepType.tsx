import { Printer, Monitor } from 'lucide-react';
import type { RequestCategory } from '../../types/request';

interface Props {
  value: RequestCategory | null;
  onChange: (val: RequestCategory) => void;
}

export default function StepType({ value, onChange }: Props) {
  return (
    <div className="step-content">
      <div className="step-header">
        <h2>What type of media do you need?</h2>
        <p>Select whether you need a physical print product or a digital asset.</p>
      </div>

      <div className="type-cards">
        <button
          className={`type-card ${value === 'print' ? 'selected' : ''}`}
          onClick={() => onChange('print')}
        >
          <div className="type-card-icon purple">
            <Printer size={32} />
          </div>
          <div className="type-card-body">
            <h3>Print Media</h3>
            <p>
              Physical printed products — posters, banners, business cards,
              brochures, copies, signage & more.
            </p>
            <ul className="type-card-list">
              <li>Posters & Banners</li>
              <li>Business Cards</li>
              <li>Copies & Reproduction</li>
              <li>Brochures & Flyers</li>
              <li>Large Format Printing</li>
            </ul>
          </div>
        </button>

        <button
          className={`type-card ${value === 'digital' ? 'selected' : ''}`}
          onClick={() => onChange('digital')}
        >
          <div className="type-card-icon blue">
            <Monitor size={32} />
          </div>
          <div className="type-card-body">
            <h3>Digital Media</h3>
            <p>
              Digital assets & designs — graphics, logos, social media content,
              presentations, email templates & more.
            </p>
            <ul className="type-card-list">
              <li>Graphics & Illustrations</li>
              <li>Logo Design</li>
              <li>Social Media Assets</li>
              <li>Presentations</li>
              <li>Infographics</li>
            </ul>
          </div>
        </button>
      </div>
    </div>
  );
}
