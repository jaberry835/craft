import type { RequestCategory, SubType } from '../../types/request';
import { PRINT_SUBTYPES, DIGITAL_SUBTYPES } from '../../types/request';

interface Props {
  category: RequestCategory;
  value: string | null;
  onChange: (val: string) => void;
}

export default function StepSubType({ category, value, onChange }: Props) {
  const subtypes: SubType[] = category === 'print' ? PRINT_SUBTYPES : DIGITAL_SUBTYPES;
  const title = category === 'print' ? 'What print service do you need?' : 'What digital service do you need?';
  const subtitle = category === 'print'
    ? 'Choose the type of printed product you\'d like to request.'
    : 'Choose the type of digital asset you\'d like to request.';

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      <div className="subtype-grid">
        {subtypes.map((st) => (
          <button
            key={st.id}
            className={`subtype-card ${value === st.id ? 'selected' : ''}`}
            onClick={() => onChange(st.id)}
          >
            <span className="subtype-icon">{st.icon}</span>
            <div className="subtype-info">
              <span className="subtype-label">{st.label}</span>
              <span className="subtype-desc">{st.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
