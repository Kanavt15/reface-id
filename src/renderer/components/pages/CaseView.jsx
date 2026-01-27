import React from 'react';
import { useParams } from 'react-router-dom';

/**
 * Individual case view/details page
 */
function CaseView() {
  const { caseId } = useParams();

  return (
    <div className="case-view">
      <h1>Case Details: {caseId}</h1>
      <p>Case view component - to be implemented</p>
    </div>
  );
}

export default CaseView;
