import type { RequestFormData, PriorityLevel, DeliveryMethod } from '../../types/request';
import { PRIORITY_OPTIONS, DELIVERY_OPTIONS } from '../../types/request';
import { Clock, Truck } from 'lucide-react';

interface Props {
  data: RequestFormData;
  onChange: (updates: Partial<RequestFormData>) => void;
}

export default function StepDelivery({ data, onChange }: Props) {
  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Delivery & Timeline</h2>
        <p>Set your preferred turnaround time, delivery method, and any special instructions.</p>
      </div>

      <div className="form-grid">
        {/* Priority / Turnaround */}
        <div className="form-group full-width">
          <label className="form-label required">
            <Clock size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            Priority / Turnaround Time
          </label>
          <div className="priority-options">
            {PRIORITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`priority-card ${data.priority === opt.value ? 'selected' : ''}`}
                onClick={() => onChange({ priority: opt.value as PriorityLevel })}
              >
                <span className="priority-label">{opt.label}</span>
                <span className="priority-turnaround">{opt.turnaround}</span>
                <span className="priority-surcharge">{opt.surcharge}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Requested Completion Date */}
        <div className="form-group">
          <label className="form-label">Requested Completion Date</label>
          <input
            type="date"
            className="form-input"
            value={data.requestedDate}
            onChange={(e) => onChange({ requestedDate: e.target.value })}
          />
        </div>

        {/* Delivery Method */}
        <div className="form-group full-width">
          <label className="form-label required">
            <Truck size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            Delivery Method
          </label>
          <div className="delivery-options">
            {DELIVERY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`delivery-card ${data.deliveryMethod === opt.value ? 'selected' : ''}`}
                onClick={() => onChange({ deliveryMethod: opt.value as DeliveryMethod })}
              >
                <span className="delivery-label">{opt.label}</span>
                <span className="delivery-desc">{opt.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Delivery Address (conditional) */}
        {(data.deliveryMethod === 'interoffice' || data.deliveryMethod === 'shipping') && (
          <div className="form-group full-width">
            <label className="form-label required">
              {data.deliveryMethod === 'shipping' ? 'Shipping Address' : 'Office / Mail Stop'}
            </label>
            <textarea
              className="form-textarea"
              rows={3}
              placeholder={
                data.deliveryMethod === 'shipping'
                  ? 'Full shipping address including building, room, city, state, zip...'
                  : 'Building, room number, mail stop code...'
              }
              value={data.deliveryAddress}
              onChange={(e) => onChange({ deliveryAddress: e.target.value })}
            />
          </div>
        )}

        {/* Special Instructions */}
        <div className="form-group full-width">
          <label className="form-label">Special Instructions</label>
          <textarea
            className="form-textarea"
            rows={3}
            placeholder="Any additional notes, delivery timing preferences, or special handling requirements..."
            value={data.specialInstructions}
            onChange={(e) => onChange({ specialInstructions: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
