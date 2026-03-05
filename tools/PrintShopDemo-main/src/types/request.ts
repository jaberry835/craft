/* ===== Request Wizard Types ===== */

export type RequestCategory = 'print' | 'digital';

export interface SubType {
  id: string;
  label: string;
  description: string;
  icon: string; // emoji for simplicity
}

export const PRINT_SUBTYPES: SubType[] = [
  { id: 'posters', label: 'Posters', description: 'Wall posters, event posters & display prints', icon: '🖼️' },
  { id: 'banners', label: 'Banners & Signage', description: 'Roll-up banners, yard signs & vinyl signage', icon: '🪧' },
  { id: 'copies', label: 'Copies & Reproduction', description: 'Document copies, manuals & bulk reproduction', icon: '📄' },
  { id: 'business-cards', label: 'Business Cards', description: 'Standard, premium & specialty cards', icon: '💳' },
  { id: 'brochures', label: 'Brochures & Flyers', description: 'Tri-fold, bi-fold & single-page handouts', icon: '📰' },
  { id: 'letterhead', label: 'Letterhead & Stationery', description: 'Official letterhead, envelopes & notepads', icon: '✉️' },
  { id: 'large-format', label: 'Large Format Printing', description: 'Oversized prints, wraps & wall graphics', icon: '📐' },
  { id: 'booklets', label: 'Booklets & Reports', description: 'Bound reports, training booklets & programs', icon: '📚' },
];

export const DIGITAL_SUBTYPES: SubType[] = [
  { id: 'graphics', label: 'Graphics & Illustrations', description: 'Custom artwork, icons & visual assets', icon: '🎨' },
  { id: 'logo-design', label: 'Logo Design', description: 'New logos, refreshes & brand marks', icon: '✏️' },
  { id: 'social-media', label: 'Social Media Assets', description: 'Posts, stories, headers & profile graphics', icon: '📱' },
  { id: 'web-banners', label: 'Web Banners & Headers', description: 'Website banners, hero images & web graphics', icon: '🌐' },
  { id: 'email-templates', label: 'Email Templates', description: 'Newsletter, announcement & campaign templates', icon: '📧' },
  { id: 'presentations', label: 'Presentation Design', description: 'Slide decks, briefings & presentation templates', icon: '📊' },
  { id: 'infographics', label: 'Infographics', description: 'Data visualizations & informational graphics', icon: '📈' },
  { id: 'video-motion', label: 'Video & Motion Graphics', description: 'Intro videos, animations & motion assets', icon: '🎬' },
];

export type ClassificationLevel =
  | 'unclassified'
  | 'cui'
  | 'fouo'
  | 'super-classified';

export const CLASSIFICATION_OPTIONS: { value: ClassificationLevel; label: string; description: string }[] = [
  { value: 'unclassified', label: 'Unclassified / Public', description: 'No restrictions — suitable for public release' },
  { value: 'fouo', label: 'For Official Use Only (FOUO)', description: 'Internal government use — not for public release' },
  { value: 'cui', label: 'Controlled Unclassified (CUI)', description: 'Requires safeguarding per CUI program guidelines' },
  { value: 'super-classified', label: 'Super Classified', description: 'Highest restriction — requires director-level approval & secure handling' },
];

export type PriorityLevel = 'standard' | 'expedited' | 'rush';

export const PRIORITY_OPTIONS: { value: PriorityLevel; label: string; turnaround: string; surcharge: string }[] = [
  { value: 'standard', label: 'Standard', turnaround: '10–15 business days', surcharge: 'No surcharge' },
  { value: 'expedited', label: 'Expedited', turnaround: '5–7 business days', surcharge: '+25% surcharge' },
  { value: 'rush', label: 'Rush', turnaround: '1–3 business days', surcharge: '+50% surcharge — requires supervisor approval' },
];

export type DeliveryMethod = 'pickup' | 'interoffice' | 'digital' | 'shipping';

export const DELIVERY_OPTIONS: { value: DeliveryMethod; label: string; description: string }[] = [
  { value: 'pickup', label: 'In-Person Pickup', description: 'Pick up at the Print Shop facility' },
  { value: 'interoffice', label: 'Inter-Office Mail', description: 'Delivered via internal mail system' },
  { value: 'digital', label: 'Digital Delivery', description: 'Sent via email or shared drive' },
  { value: 'shipping', label: 'Ship to Address', description: 'Shipped to specified location' },
];

export interface RequestFormData {
  // Step 1 - Category
  category: RequestCategory | null;

  // Step 2 - Sub-type
  subType: string | null;

  // Step 3 - Request details
  projectTitle: string;
  description: string;
  quantity: number | null;
  dimensions: string;
  colorRequirements: string;
  classificationLevel: ClassificationLevel | null;
  distribution: string;

  // Step 4 - Customer / POC
  requestorName: string;
  requestorEmail: string;
  requestorPhone: string;
  department: string;
  officeSymbol: string;
  buildingLocation: string;
  roomNumber: string;
  supervisorName: string;
  supervisorEmail: string;
  fundCite: string;
  costCenter: string;

  // Step 5 - Delivery & timeline
  priority: PriorityLevel | null;
  requestedDate: string;
  deliveryMethod: DeliveryMethod | null;
  deliveryAddress: string;
  specialInstructions: string;
}

export const INITIAL_FORM_DATA: RequestFormData = {
  category: null,
  subType: null,
  projectTitle: '',
  description: '',
  quantity: null,
  dimensions: '',
  colorRequirements: '',
  classificationLevel: null,
  distribution: '',
  requestorName: '',
  requestorEmail: '',
  requestorPhone: '',
  department: '',
  officeSymbol: '',
  buildingLocation: '',
  roomNumber: '',
  supervisorName: '',
  supervisorEmail: '',
  fundCite: '',
  costCenter: '',
  priority: null,
  requestedDate: '',
  deliveryMethod: null,
  deliveryAddress: '',
  specialInstructions: '',
};

export const WIZARD_STEPS = [
  { id: 1, label: 'Type', shortLabel: 'Type' },
  { id: 2, label: 'Service', shortLabel: 'Service' },
  { id: 3, label: 'Details', shortLabel: 'Details' },
  { id: 4, label: 'Contact', shortLabel: 'Contact' },
  { id: 5, label: 'Delivery', shortLabel: 'Delivery' },
  { id: 6, label: 'Review', shortLabel: 'Review' },
];
