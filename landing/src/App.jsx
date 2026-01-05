import { useEffect, useState } from 'react';
import demoData from './demoData.json';
import { Container, Card, Navbar, Nav, Button } from 'react-bootstrap';
import { IconContext } from 'react-icons';
import { AiOutlineRobot, AiOutlineStock, AiOutlineSecurityScan, AiOutlineApi } from 'react-icons/ai';
import './App.css';

function App() {
  const [demos, setDemos] = useState([]);
  const [filter, setFilter] = useState('All');

  useEffect(() => {
    setDemos(demoData);
  }, []);

  const categories = ['All', ...Array.from(new Set(demos.map(d => d.category)))];
  const filteredDemos = filter === 'All' ? demos : demos.filter(d => d.category === filter);

  const iconMap = {
    AI: <AiOutlineRobot />,
    Security: <AiOutlineSecurityScan />,
    Infrastructure: <AiOutlineApi />, // placeholder
    DataScience: <AiOutlineStock />
  };

  return (
    <>
      <Navbar bg="white" sticky="top" className="shadow-sm w-100">
        <Container fluid className="px-0">
          <Navbar.Brand className="px-4">Azure IC Demos</Navbar.Brand>
        </Container>
      </Navbar>
      <main className="main-section py-5">
        <div className="content-wrapper mx-auto px-3">
          <Nav variant="pills" className="justify-content-center mb-4">
            {categories.map(cat => (
              <Nav.Item key={cat}>
                <Nav.Link active={filter === cat} onClick={() => setFilter(cat)}>
                  {cat}
                </Nav.Link>
              </Nav.Item>
            ))}
          </Nav>
          <div className="cards-grid">
            {filteredDemos.map(demo => (
              <Card key={demo.title} className={`demo-card ${demo.comingSoon ? 'coming-soon' : ''}`}>  
                <Card.Body>
                  <IconContext.Provider value={{ size: '3em', className: 'demo-icon mb-3' }}>
                    {iconMap[demo.category] || iconMap['AI']}
                  </IconContext.Provider>
                  <Card.Title>{demo.title}</Card.Title>
                  <Card.Text>{demo.description}</Card.Text>
                </Card.Body>
                <Card.Footer>
                  {demo.comingSoon ? (
                    <Button variant="secondary" disabled>Coming Soon</Button>
                  ) : (
                    <>
                      <a href={demo.demoLink} className="btn btn-primary me-2">Demo</a>
                      {demo.moreInfoLink && <a href={demo.moreInfoLink} className="btn btn-secondary">More Info</a>}
                    </>
                  )}
                </Card.Footer>
              </Card>
            ))}
          </div>
        </div>
      </main>
      <footer className="footer bg-dark text-white py-4">
        <Container fluid>
          <div className="text-center">
            <h5>Azure IC Demos</h5>
            <p>Contact: youremail@example.com</p>
          </div>
        </Container>
      </footer>
    </>
  );
}

export default App;
