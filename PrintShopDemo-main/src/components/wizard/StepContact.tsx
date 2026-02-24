import type { RequestFormData } from '../../types/request';

interface Props {
  data: RequestFormData;
  onChange: (updates: Partial<RequestFormData>) => void;
}

export default function StepContact({ data, onChange }: Props) {
  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Customer & Point of Contact</h2>
        <p>Provide your contact information and funding details for this request.</p>
      </div>

      <div className="form-grid">
        {/* Section: Requestor Info */}
        <div className="form-section-title full-width">Requestor Information</div>

        <div className="form-group">
          <label className="form-label required">Full Name</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., Jane A. Smith"
            value={data.requestorName}
            onChange={(e) => onChange({ requestorName: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label required">Email Address</label>
          <input
            type="email"
            className="form-input"
            placeholder="e.g., jane.smith@agency.gov"
            value={data.requestorEmail}
            onChange={(e) => onChange({ requestorEmail: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label required">Phone Number</label>
          <input
            type="tel"
            className="form-input"
            placeholder="e.g., (555) 123-4567"
            value={data.requestorPhone}
            onChange={(e) => onChange({ requestorPhone: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label required">Department / Directorate</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., Office of Public Affairs"
            value={data.department}
            onChange={(e) => onChange({ department: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Office Symbol</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., OPA-3"
            value={data.officeSymbol}
            onChange={(e) => onChange({ officeSymbol: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label required">Building / Location</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., Building 401, Rm 215"
            value={data.buildingLocation}
            onChange={(e) => onChange({ buildingLocation: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Room Number</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., 215"
            value={data.roomNumber}
            onChange={(e) => onChange({ roomNumber: e.target.value })}
          />
        </div>

        {/* Section: Supervisor / Approver */}
        <div className="form-section-title full-width">Approving Official</div>

        <div className="form-group">
          <label className="form-label required">Supervisor Name</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., Col. Robert J. Davis"
            value={data.supervisorName}
            onChange={(e) => onChange({ supervisorName: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label required">Supervisor Email</label>
          <input
            type="email"
            className="form-input"
            placeholder="e.g., robert.davis@agency.gov"
            value={data.supervisorEmail}
            onChange={(e) => onChange({ supervisorEmail: e.target.value })}
          />
        </div>

        {/* Section: Funding */}
        <div className="form-section-title full-width">Funding Information</div>

        <div className="form-group">
          <label className="form-label required">Fund Cite / Appropriation Code</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., 97X4930.002"
            value={data.fundCite}
            onChange={(e) => onChange({ fundCite: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label className="form-label required">Cost Center / RC Code</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., CC-4401-OPA"
            value={data.costCenter}
            onChange={(e) => onChange({ costCenter: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
