import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { RequestFormData } from '../types/request';
import { INITIAL_FORM_DATA } from '../types/request';

interface FormContextValue {
  formData: RequestFormData;
  updateForm: (updates: Partial<RequestFormData>) => void;
  resetForm: () => void;
}

const FormContext = createContext<FormContextValue | null>(null);

export function FormProvider({ children }: { children: ReactNode }) {
  const [formData, setFormData] = useState<RequestFormData>({ ...INITIAL_FORM_DATA });

  const updateForm = useCallback((updates: Partial<RequestFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetForm = useCallback(() => {
    setFormData({ ...INITIAL_FORM_DATA });
  }, []);

  return (
    <FormContext.Provider value={{ formData, updateForm, resetForm }}>
      {children}
    </FormContext.Provider>
  );
}

export function useFormContext(): FormContextValue {
  const ctx = useContext(FormContext);
  if (!ctx) throw new Error('useFormContext must be used within a FormProvider');
  return ctx;
}
