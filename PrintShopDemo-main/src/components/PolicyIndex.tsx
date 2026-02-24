import { Link } from 'react-router-dom';
import { POLICIES } from '../data/policies';
import { BookOpen, ArrowRight } from 'lucide-react';
import './PolicyIndex.css';

export default function PolicyIndex() {
  return (
    <div className="policy-index">
      <div className="policy-index-header">
        <BookOpen size={32} />
        <div>
          <h1>FCA Directives &amp; Policies</h1>
          <p className="policy-index-subtitle">
            Official governing directives for the Federal Consolidated Agency
            Print &amp; Digital Media Center. All media production requests are
            subject to these policies.
          </p>
        </div>
      </div>

      <div className="policy-grid">
        {POLICIES.map((policy) => (
          <Link
            key={policy.id}
            to={`/policies/${policy.id}`}
            className="policy-card"
          >
            <div className="policy-card-icon">{policy.icon}</div>
            <div className="policy-card-body">
              <span className="policy-card-number">Directive {policy.number}</span>
              <h3 className="policy-card-title">{policy.title}</h3>
              <p className="policy-card-desc">{policy.description}</p>
            </div>
            <ArrowRight size={18} className="policy-card-arrow" />
          </Link>
        ))}
      </div>
    </div>
  );
}
