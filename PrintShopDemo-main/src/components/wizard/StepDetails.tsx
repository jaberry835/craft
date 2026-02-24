import { AlertTriangle } from 'lucide-react';
import type { RequestFormData, ClassificationLevel } from '../../types/request';
import { CLASSIFICATION_OPTIONS } from '../../types/request';

interface Props {
  data: RequestFormData;
  onChange: (updates: Partial<RequestFormData>) => void;
}

export default function StepDetails({ data, onChange }: Props) {
  const isPrint = data.category === 'print';

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Request Details</h2>
        <p>Provide the specifics of your request. The more detail you include, the better we can serve you.</p>
      </div>

      <div className="form-grid">
        {/* Project Title */}
        <div className="form-group full-width">
          <label className="form-label required">Project Title</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., Q3 Safety Awareness Campaign Poster"
            value={data.projectTitle}
            onChange={(e) => onChange({ projectTitle: e.target.value })}
          />
        </div>

        {/* Description */}
        <div className="form-group full-width">
          <label className="form-label required">Description of Request</label>
          <textarea
            className="form-textarea"
            rows={5}
            placeholder="Describe what you need, including content, messaging, imagery preferences, and any specific requirements..."
            value={data.description}
            onChange={(e) => onChange({ description: e.target.value })}
          />
          <div className="form-hint">
            <AlertTriangle size={12} />
            <span>This description will be validated against agency print & media policies by our AI assistant.</span>
          </div>
        </div>

        {/* Quantity (print only) */}
        {isPrint && (
          <div className="form-group">
            <label className="form-label required">Quantity</label>
            <input
              type="number"
              className="form-input"
              placeholder="e.g., 500"
              min={1}
              value={data.quantity ?? ''}
              onChange={(e) => onChange({ quantity: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
        )}

        {/* Dimensions / Size */}
        <div className="form-group">
          <label className="form-label">Dimensions / Size</label>
          <input
            type="text"
            className="form-input"
            placeholder={isPrint ? 'e.g., 24" x 36" or 8.5" x 11"' : 'e.g., 1920x1080px or 1080x1080px'}
            value={data.dimensions}
            onChange={(e) => onChange({ dimensions: e.target.value })}
          />
        </div>

        {/* Color Requirements */}
        <div className="form-group">
          <label className="form-label">Color Requirements</label>
          <select
            className="form-select"
            value={data.colorRequirements}
            onChange={(e) => onChange({ colorRequirements: e.target.value })}
          >
            <option value="">Select...</option>
            <option value="full-color">Full Color (CMYK)</option>
            <option value="black-white">Black & White</option>
            <option value="spot-color">Spot Color / PMS</option>
            <option value="agency-brand">Agency Brand Colors Only</option>
          </select>
        </div>

        {/* Classification */}
        <div className="form-group full-width">
          <label className="form-label required">Classification Level</label>
          <div className="classification-options">
            {CLASSIFICATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`classification-btn ${data.classificationLevel === opt.value ? 'selected' : ''}`}
                onClick={() => onChange({ classificationLevel: opt.value as ClassificationLevel })}
              >
                <span className="classification-label">{opt.label}</span>
                <span className="classification-desc">{opt.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Distribution Statement */}
        <div className="form-group full-width">
          <label className="form-label">Distribution Statement</label>
          <select
            className="form-select"
            value={data.distribution}
            onChange={(e) => onChange({ distribution: e.target.value })}
          >
            <option value="">Select distribution statement...</option>
            <option value="dist-a">Distribution A — Approved for public release; unlimited distribution</option>
            <option value="dist-c">Distribution C — Authorized government agencies & contractors only</option>
            <option value="dist-d">Distribution D — Authorized DoD components only</option>
            <option value="dist-f">Distribution F — Further dissemination only as directed</option>
            <option value="internal">Internal Use Only — Within requesting organization</option>
          </select>
        </div>
      </div>
    </div>
  );
}
