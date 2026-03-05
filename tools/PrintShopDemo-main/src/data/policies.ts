/* ===== Policy Registry ===== */

// Raw markdown imports via Vite's ?raw suffix
import directive925 from '../../policies/DIRECTIVE-925-Brand-Identity-Standards.md?raw';
import directive1000 from '../../policies/DIRECTIVE-1000-General-Policy.md?raw';
import directive1010 from '../../policies/DIRECTIVE-1010-Print-Media-Standards.md?raw';
import directive1020 from '../../policies/DIRECTIVE-1020-Digital-Media-Standards.md?raw';
import directive1050 from '../../policies/DIRECTIVE-1050-Financial-Approval.md?raw';
import directive1100 from '../../policies/DIRECTIVE-1100-Content-Review-Compliance.md?raw';
import directive1150 from '../../policies/DIRECTIVE-1150-Delivery-Fulfillment.md?raw';
import directive1200 from '../../policies/DIRECTIVE-1200-Classification-Security.md?raw';

export interface PolicyMeta {
  id: string;           // URL slug, e.g. "directive-1200"
  number: string;       // e.g. "1200"
  title: string;        // short title
  fullTitle: string;    // directive line from the document
  description: string;  // one-liner
  category: 'general' | 'print' | 'digital' | 'security' | 'financial' | 'content' | 'delivery' | 'branding';
  icon: string;         // emoji
  content: string;      // raw markdown
}

export const POLICIES: PolicyMeta[] = [
  {
    id: 'directive-925',
    number: '925',
    title: 'Brand Identity & Visual Standards',
    fullTitle: 'DIRECTIVE 925 — Federal Consolidated Agency Brand Identity & Visual Standards',
    description: 'Logo usage, color palette, typography, photography, layout & template requirements.',
    category: 'branding',
    icon: '🎨',
    content: directive925,
  },
  {
    id: 'directive-1000',
    number: '1000',
    title: 'General Policy',
    fullTitle: 'DIRECTIVE 1000 — Print & Digital Media Center General Operating Policy',
    description: 'Overarching policies: approval chains, request lifecycle, records retention.',
    category: 'general',
    icon: '📋',
    content: directive1000,
  },
  {
    id: 'directive-1010',
    number: '1010',
    title: 'Print Media Standards',
    fullTitle: 'DIRECTIVE 1010 — Print Media Production Standards',
    description: 'Specifications for posters, banners, copies, business cards, brochures, large format, letterhead & booklets.',
    category: 'print',
    icon: '🖨️',
    content: directive1010,
  },
  {
    id: 'directive-1020',
    number: '1020',
    title: 'Digital Media Standards',
    fullTitle: 'DIRECTIVE 1020 — Digital Media Production Standards',
    description: 'Specifications for graphics, logos, social media, web banners, email templates, presentations, infographics & video.',
    category: 'digital',
    icon: '💻',
    content: directive1020,
  },
  {
    id: 'directive-1050',
    number: '1050',
    title: 'Financial Management & Approval',
    fullTitle: 'DIRECTIVE 1050 — Financial Management, Cost Estimation & Approval Authority for Media Products',
    description: 'Cost tables, surcharges, approval thresholds, fund cite requirements & chargeback procedures.',
    category: 'financial',
    icon: '💰',
    content: directive1050,
  },
  {
    id: 'directive-1100',
    number: '1100',
    title: 'Content Review & Compliance',
    fullTitle: 'DIRECTIVE 1100 — Content Review, Compliance & Description Standards',
    description: 'Description requirements per service type, prohibited content, mandatory disclaimers & AI-generated content rules.',
    category: 'content',
    icon: '✅',
    content: directive1100,
  },
  {
    id: 'directive-1150',
    number: '1150',
    title: 'Delivery & Fulfillment',
    fullTitle: 'DIRECTIVE 1150 — Delivery, Fulfillment & Turnaround Standards',
    description: 'Turnaround timelines, delivery methods, courier protocols, shipping restrictions & acceptance standards.',
    category: 'delivery',
    icon: '📦',
    content: directive1150,
  },
  {
    id: 'directive-1200',
    number: '1200',
    title: 'Classification & Security',
    fullTitle: 'DIRECTIVE 1200 — Information Classification & Security Requirements for Media Products',
    description: 'Classification levels, content restrictions, marking requirements, security violations & handling procedures.',
    category: 'security',
    icon: '🔒',
    content: directive1200,
  },
];

/** Look up a policy by its URL slug (e.g. "directive-1200") */
export function getPolicyById(id: string): PolicyMeta | undefined {
  return POLICIES.find((p) => p.id === id);
}

/** Look up a policy by its number (e.g. "1200") */
export function getPolicyByNumber(num: string): PolicyMeta | undefined {
  return POLICIES.find((p) => p.number === num);
}

/**
 * Generate an in-app URL for a policy + optional section anchor.
 * Usage:  policyUrl('1200')            → "/policies/directive-1200"
 *         policyUrl('1200', '2.1')     → "/policies/directive-1200#section-2-1"
 *         policyUrl('1200', '2.4.6')   → "/policies/directive-1200#section-2-4-6"
 *
 * The agent backend can use this same logic to emit links in chat messages.
 */
export function policyUrl(directiveNumber: string, section?: string): string {
  const base = `/policies/directive-${directiveNumber}`;
  if (!section) return base;
  // Convert "2.4.6" → "section-2-4-6"
  const anchor = `section-${section.replace(/\./g, '-')}`;
  return `${base}#${anchor}`;
}
