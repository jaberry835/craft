import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { RequestFormData } from '../../types/request';
import {
  PRINT_SUBTYPES,
  DIGITAL_SUBTYPES,
  CLASSIFICATION_OPTIONS,
  PRIORITY_OPTIONS,
  DELIVERY_OPTIONS,
} from '../../types/request';

interface Props {
  data: RequestFormData;
  onEdit: (step: number) => void;
}

function lookup(list: { id?: string; value?: string; label: string }[], key: string | null): string {
  if (!key) return '—';
  const found = list.find((i) => (i as any).id === key || (i as any).value === key);
  return found?.label ?? key;
}

export default function StepReview({ data, onEdit }: Props) {
  const subtypes = data.category === 'print' ? PRINT_SUBTYPES : DIGITAL_SUBTYPES;
  const subTypeLabel = lookup(subtypes, data.subType);
  const classLabel = lookup(CLASSIFICATION_OPTIONS, data.classificationLevel);
  const priorityLabel = lookup(PRIORITY_OPTIONS, data.priority);
  const deliveryLabel = lookup(DELIVERY_OPTIONS, data.deliveryMethod);

  // Simple completeness checks
  const issues: string[] = [];
  if (!data.projectTitle) issues.push('Project title is required');
  if (!data.description) issues.push('Description is required');
  if (!data.classificationLevel) issues.push('Classification level is required');
  if (!data.requestorName) issues.push('Requestor name is required');
  if (!data.requestorEmail) issues.push('Requestor email is required');
  if (!data.department) issues.push('Department is required');
  if (!data.fundCite) issues.push('Fund cite is required');
  if (!data.priority) issues.push('Priority selection is required');
  if (!data.deliveryMethod) issues.push('Delivery method is required');

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Review Your Request</h2>
        <p>Please verify all information below before submitting. Click any section header to go back and edit.</p>
      </div>

      {issues.length > 0 && (
        <div className="review-warnings">
          <AlertCircle size={16} />
          <div>
            <strong>{issues.length} item{issues.length > 1 ? 's' : ''} need attention:</strong>
            <ul>
              {issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Request Type & Service */}
      <div className="review-section">
        <div className="review-section-header" onClick={() => onEdit(1)}>
          <h3>Request Type & Service</h3>
          <span className="edit-link">Edit</span>
        </div>
        <div className="review-row">
          <span className="review-label">Category</span>
          <span className="review-value">{data.category === 'print' ? '🖨️ Print Media' : '🖥️ Digital Media'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Service Type</span>
          <span className="review-value">{subTypeLabel}</span>
        </div>
      </div>

      {/* Request Details */}
      <div className="review-section">
        <div className="review-section-header" onClick={() => onEdit(3)}>
          <h3>Request Details</h3>
          <span className="edit-link">Edit</span>
        </div>
        <div className="review-row">
          <span className="review-label">Project Title</span>
          <span className="review-value">{data.projectTitle || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Description</span>
          <span className="review-value description">{data.description || '—'}</span>
        </div>
        {data.category === 'print' && (
          <div className="review-row">
            <span className="review-label">Quantity</span>
            <span className="review-value">{data.quantity ?? '—'}</span>
          </div>
        )}
        <div className="review-row">
          <span className="review-label">Dimensions</span>
          <span className="review-value">{data.dimensions || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Color</span>
          <span className="review-value">{data.colorRequirements || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Classification</span>
          <span className="review-value">{classLabel}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Distribution</span>
          <span className="review-value">{data.distribution || '—'}</span>
        </div>
      </div>

      {/* Contact */}
      <div className="review-section">
        <div className="review-section-header" onClick={() => onEdit(4)}>
          <h3>Customer & Contact</h3>
          <span className="edit-link">Edit</span>
        </div>
        <div className="review-row">
          <span className="review-label">Requestor</span>
          <span className="review-value">{data.requestorName || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Email</span>
          <span className="review-value">{data.requestorEmail || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Phone</span>
          <span className="review-value">{data.requestorPhone || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Department</span>
          <span className="review-value">{data.department || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Office Symbol</span>
          <span className="review-value">{data.officeSymbol || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Location</span>
          <span className="review-value">{data.buildingLocation || '—'}{data.roomNumber ? `, Rm ${data.roomNumber}` : ''}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Supervisor</span>
          <span className="review-value">{data.supervisorName || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Fund Cite</span>
          <span className="review-value">{data.fundCite || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Cost Center</span>
          <span className="review-value">{data.costCenter || '—'}</span>
        </div>
      </div>

      {/* Delivery */}
      <div className="review-section">
        <div className="review-section-header" onClick={() => onEdit(5)}>
          <h3>Delivery & Timeline</h3>
          <span className="edit-link">Edit</span>
        </div>
        <div className="review-row">
          <span className="review-label">Priority</span>
          <span className="review-value">{priorityLabel}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Requested Date</span>
          <span className="review-value">{data.requestedDate || '—'}</span>
        </div>
        <div className="review-row">
          <span className="review-label">Delivery Method</span>
          <span className="review-value">{deliveryLabel}</span>
        </div>
        {data.specialInstructions && (
          <div className="review-row">
            <span className="review-label">Special Instructions</span>
            <span className="review-value description">{data.specialInstructions}</span>
          </div>
        )}
      </div>

      {issues.length === 0 && (
        <div className="review-ready">
          <CheckCircle2 size={18} />
          <span>All required fields are complete. Your request is ready to submit.</span>
        </div>
      )}
    </div>
  );
}
