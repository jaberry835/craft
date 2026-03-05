import { useState } from 'react';
import {
  Printer,
  Monitor,
  Package,
  HelpCircle,
  Lightbulb,
  ChevronDown,
  Palette,
  FileText,
  Image,
  BookOpen,
  Megaphone,
  LayoutTemplate,
  Shirt,
  StickyNote,
  Mail,
  BarChart3,
  Clock,
  CheckCircle2,
  AlertCircle,
  Search,
  Bell,
  User,
} from 'lucide-react';
import './Navbar.css';

interface NavbarProps {
  onNavigate?: (page: string) => void;
}

export default function Navbar({ onNavigate }: NavbarProps) {
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);

  const handleMouseEnter = (menu: string) => setActiveDropdown(menu);
  const handleMouseLeave = () => setActiveDropdown(null);

  const handleNavigate = (page: string) => {
    setActiveDropdown(null);
    onNavigate?.(page);
  };

  return (
    <nav className="navbar">
      {/* Logo */}
      <div className="navbar-brand" onClick={() => handleNavigate('home')}>
        <div className="logo-icon">
          <Printer size={24} />
        </div>
        <div className="logo-text">
          <span className="logo-name">PixelPress</span>
          <span className="logo-tagline">Print & Digital Studio</span>
        </div>
      </div>

      {/* Main Nav Items */}
      <div className="navbar-menu">
        {/* Request Digital Media */}
        <div
          className="nav-item has-dropdown"
          onMouseEnter={() => handleMouseEnter('digital')}
          onMouseLeave={handleMouseLeave}
        >
          <button className="nav-link">
            <Monitor size={16} />
            <span>Request Digital Media</span>
            <ChevronDown size={14} className={`chevron ${activeDropdown === 'digital' ? 'open' : ''}`} />
          </button>
          {activeDropdown === 'digital' && (
            <div className="dropdown-menu">
              <div className="dropdown-header">Digital Services</div>
              <button className="dropdown-item" onClick={() => handleNavigate('social-media')}>
                <Megaphone size={16} />
                <div>
                  <span className="dropdown-item-title">Social Media Graphics</span>
                  <span className="dropdown-item-desc">Posts, stories, ads & covers</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('web-assets')}>
                <LayoutTemplate size={16} />
                <div>
                  <span className="dropdown-item-title">Web Assets</span>
                  <span className="dropdown-item-desc">Banners, headers & web graphics</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('email-templates')}>
                <Mail size={16} />
                <div>
                  <span className="dropdown-item-title">Email Templates</span>
                  <span className="dropdown-item-desc">Newsletter & campaign designs</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('presentations')}>
                <BarChart3 size={16} />
                <div>
                  <span className="dropdown-item-title">Presentations</span>
                  <span className="dropdown-item-desc">Slide decks & pitch materials</span>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Request Print Media */}
        <div
          className="nav-item has-dropdown"
          onMouseEnter={() => handleMouseEnter('print')}
          onMouseLeave={handleMouseLeave}
        >
          <button className="nav-link">
            <Printer size={16} />
            <span>Request Print Media</span>
            <ChevronDown size={14} className={`chevron ${activeDropdown === 'print' ? 'open' : ''}`} />
          </button>
          {activeDropdown === 'print' && (
            <div className="dropdown-menu">
              <div className="dropdown-header">Print Services</div>
              <button className="dropdown-item" onClick={() => handleNavigate('business-cards')}>
                <StickyNote size={16} />
                <div>
                  <span className="dropdown-item-title">Business Cards</span>
                  <span className="dropdown-item-desc">Standard, premium & specialty</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('brochures')}>
                <BookOpen size={16} />
                <div>
                  <span className="dropdown-item-title">Brochures & Flyers</span>
                  <span className="dropdown-item-desc">Tri-fold, bi-fold & single page</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('posters')}>
                <Image size={16} />
                <div>
                  <span className="dropdown-item-title">Posters & Banners</span>
                  <span className="dropdown-item-desc">Large format & signage</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('branded-merch')}>
                <Shirt size={16} />
                <div>
                  <span className="dropdown-item-title">Branded Merchandise</span>
                  <span className="dropdown-item-desc">Apparel, mugs & promotional items</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('stationery')}>
                <FileText size={16} />
                <div>
                  <span className="dropdown-item-title">Stationery & Letterhead</span>
                  <span className="dropdown-item-desc">Envelopes, notepads & letterhead</span>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Track Orders */}
        <div
          className="nav-item has-dropdown"
          onMouseEnter={() => handleMouseEnter('track')}
          onMouseLeave={handleMouseLeave}
        >
          <button className="nav-link">
            <Package size={16} />
            <span>Track Orders</span>
            <ChevronDown size={14} className={`chevron ${activeDropdown === 'track' ? 'open' : ''}`} />
          </button>
          {activeDropdown === 'track' && (
            <div className="dropdown-menu">
              <div className="dropdown-header">Order Management</div>
              <button className="dropdown-item" onClick={() => handleNavigate('active-orders')}>
                <Clock size={16} />
                <div>
                  <span className="dropdown-item-title">Active Orders</span>
                  <span className="dropdown-item-desc">View orders in progress</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('completed-orders')}>
                <CheckCircle2 size={16} />
                <div>
                  <span className="dropdown-item-title">Completed Orders</span>
                  <span className="dropdown-item-desc">Past order history & re-orders</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('pending-review')}>
                <AlertCircle size={16} />
                <div>
                  <span className="dropdown-item-title">Pending Review</span>
                  <span className="dropdown-item-desc">Orders awaiting your approval</span>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Get Design Ideas */}
        <div className="nav-item">
          <button className="nav-link" onClick={() => handleNavigate('design-ideas')}>
            <Lightbulb size={16} />
            <span>Get Design Ideas</span>
          </button>
        </div>

        {/* Help */}
        <div
          className="nav-item has-dropdown"
          onMouseEnter={() => handleMouseEnter('help')}
          onMouseLeave={handleMouseLeave}
        >
          <button className="nav-link">
            <HelpCircle size={16} />
            <span>Help</span>
            <ChevronDown size={14} className={`chevron ${activeDropdown === 'help' ? 'open' : ''}`} />
          </button>
          {activeDropdown === 'help' && (
            <div className="dropdown-menu dropdown-right">
              <div className="dropdown-header">Support</div>
              <button className="dropdown-item" onClick={() => handleNavigate('faq')}>
                <HelpCircle size={16} />
                <div>
                  <span className="dropdown-item-title">FAQ</span>
                  <span className="dropdown-item-desc">Common questions answered</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('policies')}>
                <BookOpen size={16} />
                <div>
                  <span className="dropdown-item-title">Policies &amp; Directives</span>
                  <span className="dropdown-item-desc">All FCA media directives</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('brand-guidelines')}>
                <Palette size={16} />
                <div>
                  <span className="dropdown-item-title">Brand Guidelines</span>
                  <span className="dropdown-item-desc">Colors, fonts &amp; identity standards</span>
                </div>
              </button>
              <button className="dropdown-item" onClick={() => handleNavigate('contact')}>
                <Mail size={16} />
                <div>
                  <span className="dropdown-item-title">Contact Support</span>
                  <span className="dropdown-item-desc">Chat, email or phone</span>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right side utilities */}
      <div className="navbar-actions">
        <button className="action-btn" title="Search">
          <Search size={18} />
        </button>
        <button className="action-btn has-badge" title="Notifications">
          <Bell size={18} />
          <span className="badge">3</span>
        </button>
        <div className="avatar-btn" title="Account">
          <User size={18} />
        </div>
      </div>
    </nav>
  );
}
