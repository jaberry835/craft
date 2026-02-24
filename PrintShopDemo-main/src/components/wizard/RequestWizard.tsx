import { useState, useEffect } from 'react';
import { ArrowLeft, ArrowRight, Send, X } from 'lucide-react';
import type { RequestCategory } from '../../types/request';
import { WIZARD_STEPS } from '../../types/request';
import { useFormContext } from '../../contexts/FormContext';
import StepType from './StepType';
import StepSubType from './StepSubType';
import StepDetails from './StepDetails';
import StepContact from './StepContact';
import StepDelivery from './StepDelivery';
import StepReview from './StepReview';
import './RequestWizard.css';

interface Props {
  /** Pre-select a category when launched from navbar */
  initialCategory?: RequestCategory;
  onClose: () => void;
}

export default function RequestWizard({ initialCategory, onClose }: Props) {
  const { formData, updateForm, resetForm } = useFormContext();
  const [currentStep, setCurrentStep] = useState(initialCategory ? 2 : 1);
  const [submitted, setSubmitted] = useState(false);

  // Apply initial category on mount if provided
  useEffect(() => {
    if (initialCategory && formData.category !== initialCategory) {
      updateForm({ category: initialCategory, subType: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canProceed = (): boolean => {
    switch (currentStep) {
      case 1: return formData.category !== null;
      case 2: return formData.subType !== null;
      case 3: return !!(formData.projectTitle && formData.description && formData.classificationLevel);
      case 4: return !!(formData.requestorName && formData.requestorEmail && formData.department && formData.fundCite);
      case 5: return !!(formData.priority && formData.deliveryMethod);
      case 6: return true;
      default: return false;
    }
  };

  const handleNext = () => {
    if (currentStep < 6) setCurrentStep((s) => s + 1);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep((s) => s - 1);
  };

  const handleSubmit = () => {
    setSubmitted(true);
  };

  const handleEditFromReview = (step: number) => {
    setCurrentStep(step);
  };

  if (submitted) {
    return (
      <div className="wizard-container">
        <div className="wizard-success">
          <div className="success-icon">✅</div>
          <h2>Request Submitted Successfully!</h2>
          <p>
            Your request <strong>#{Math.random().toString(36).substring(2, 10).toUpperCase()}</strong> has been
            submitted and is pending review.
          </p>
          <p className="success-detail">
            A confirmation has been sent to <strong>{formData.requestorEmail}</strong>.
            Your supervisor <strong>{formData.supervisorName}</strong> will receive an
            approval request shortly.
          </p>
          <div className="success-actions">
            <button className="btn-primary" onClick={onClose}>
              Return to Home
            </button>
            <button className="btn-secondary" onClick={() => { setSubmitted(false); resetForm(); setCurrentStep(1); }}>
              Submit Another Request
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-container">
      {/* Top bar */}
      <div className="wizard-topbar">
        <h2 className="wizard-title">New Media Request</h2>
        <button className="wizard-close" onClick={onClose} title="Cancel request">
          <X size={18} />
        </button>
      </div>

      {/* Stepper */}
      <div className="wizard-stepper">
        {WIZARD_STEPS.map((step, i) => {
          const isCompleted = currentStep > step.id;
          const isCurrent = currentStep === step.id;
          return (
            <div key={step.id} className="stepper-item-wrap">
              <button
                className={`stepper-item ${isCurrent ? 'current' : ''} ${isCompleted ? 'completed' : ''}`}
                onClick={() => isCompleted && setCurrentStep(step.id)}
                disabled={!isCompleted && !isCurrent}
              >
                <span className="stepper-number">{isCompleted ? '✓' : step.id}</span>
                <span className="stepper-label">{step.label}</span>
              </button>
              {i < WIZARD_STEPS.length - 1 && <div className={`stepper-line ${isCompleted ? 'completed' : ''}`} />}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="wizard-body">
        {currentStep === 1 && (
          <StepType
            value={formData.category}
            onChange={(val) => { updateForm({ category: val, subType: null }); }}
          />
        )}
        {currentStep === 2 && formData.category && (
          <StepSubType
            category={formData.category}
            value={formData.subType}
            onChange={(val) => updateForm({ subType: val })}
          />
        )}
        {currentStep === 3 && <StepDetails data={formData} onChange={updateForm} />}
        {currentStep === 4 && <StepContact data={formData} onChange={updateForm} />}
        {currentStep === 5 && <StepDelivery data={formData} onChange={updateForm} />}
        {currentStep === 6 && <StepReview data={formData} onEdit={handleEditFromReview} />}
      </div>

      {/* Footer navigation */}
      <div className="wizard-footer">
        <button className="btn-secondary" onClick={handleBack} disabled={currentStep === 1}>
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>

        <div className="wizard-footer-info">
          Step {currentStep} of {WIZARD_STEPS.length}
        </div>

        {currentStep < 6 ? (
          <button className="btn-primary" onClick={handleNext} disabled={!canProceed()}>
            <span>Continue</span>
            <ArrowRight size={16} />
          </button>
        ) : (
          <button className="btn-primary submit" onClick={handleSubmit} disabled={!canProceed()}>
            <span>Submit Request</span>
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
