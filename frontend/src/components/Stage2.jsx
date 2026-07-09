import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import './Stage2.css';

function getLabelToDisplayName(labelToModel) {
  if (!labelToModel) return {};

  // Create a map of label -> distinct name with index if multiple samples exist
  const labelToName = {};
  const modelCounts = {};
  const modelTotalCounts = {};

  // Count totals first
  Object.values(labelToModel).forEach(model => {
    modelTotalCounts[model] = (modelTotalCounts[model] || 0) + 1;
  });

  // We sort keys to ensure deterministic ordering (1, 2, 3...)
  Object.keys(labelToModel).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(label => {
    const model = labelToModel[label];
    if (!modelCounts[model]) modelCounts[model] = 0;
    modelCounts[model]++;
    
    const shortName = model.split('/')[1] || model;
    const suffix = modelTotalCounts[model] > 1 ? ` #${modelCounts[model]}` : '';
    labelToName[label] = `${shortName}${suffix}`;
  });
  
  return labelToName;
}

function deAnonymizeText(text, labelToDisplayName) {
  if (!labelToDisplayName) return text;
  
  let result = text;
  // Sort labels by length descending to handle "Response 10" before "Response 1"
  const sortedLabels = Object.keys(labelToDisplayName).sort((a, b) => b.length - a.length);
  
  // Replace each "Response X" with the actual model name
  sortedLabels.forEach(label => {
    const displayName = labelToDisplayName[label];
    result = result.replace(new RegExp(label, 'g'), `**${displayName}**`);
  });
  return result;
}

export default function Stage2({ rankings, labelToModel, aggregateRankings }) {
  const [activeTab, setActiveTab] = useState(0);

  if (!rankings || rankings.length === 0) {
    return null;
  }

  const labelToDisplayName = getLabelToDisplayName(labelToModel);

  return (
    <div className="stage stage2">
      <h3 className="stage-title">Stage 2: Peer Rankings</h3>

      <h4>Raw Evaluations</h4>
      <p className="stage-description">
        Each model evaluated all responses (anonymized as Response 1, 2, 3, etc.) and provided rankings.
        Below, model names are shown in <strong>bold</strong> for readability, but the original evaluation used anonymous labels.
      </p>

      <div className="tabs">
        {rankings.map((rank, index) => (
          <button
            key={index}
            className={`tab ${activeTab === index ? 'active' : ''}`}
            onClick={() => setActiveTab(index)}
          >
            {rank.model.split('/')[1] || rank.model}
          </button>
        ))}
      </div>

      <div className="tab-content">
        <div className="ranking-model">
          {rankings[activeTab].model}
        </div>
        <div className="ranking-content markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>
            {deAnonymizeText(rankings[activeTab].ranking, labelToDisplayName)}
          </ReactMarkdown>
        </div>

        {rankings[activeTab].parsed_ranking &&
         rankings[activeTab].parsed_ranking.length > 0 && (
          <div className="parsed-ranking">
            <strong>Extracted Ranking:</strong>
            <ol>
              {rankings[activeTab].parsed_ranking.map((label, i) => (
                <li key={i}>
                  {labelToDisplayName && labelToDisplayName[label]
                    ? labelToDisplayName[label]
                    : label}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {aggregateRankings && aggregateRankings.length > 0 && (
        <div className="aggregate-rankings">
          <h4>Aggregate Rankings (Street Cred)</h4>
          <p className="stage-description">
            Combined results across all peer evaluations (lower score is better):
          </p>
          <div className="aggregate-list">
            {aggregateRankings.map((agg, index) => (
              <div key={index} className="aggregate-item">
                <span className="rank-position">#{index + 1}</span>
                <span className="rank-model">
                  {agg.model.split('/')[1] || agg.model}
                </span>
                <span className="rank-score">
                  Avg: {agg.average_rank.toFixed(2)}
                </span>
                <span className="rank-count">
                  ({agg.rankings_count} votes)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
