import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import CopyButton from './CopyButton';
import './Stage2.css';

function getLabelToDisplayName(labelToModel) {
  if (!labelToModel) return {};

  const labelToName = {};
  const modelCounts = {};
  const modelTotalCounts = {};

  Object.values(labelToModel).forEach((model) => {
    modelTotalCounts[model] = (modelTotalCounts[model] || 0) + 1;
  });

  Object.keys(labelToModel)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .forEach((label) => {
      const model = labelToModel[label];
      if (!modelCounts[model]) modelCounts[model] = 0;
      modelCounts[model]++;

      const shortName = model.split('/')[1] || model;
      const suffix = modelTotalCounts[model] > 1 ? ` #${modelCounts[model]}` : '';
      labelToName[label] = `${shortName}${suffix}`;
    });

  return labelToName;
}

function getIndexToDisplayName(labelToModel) {
  const labelToName = getLabelToDisplayName(labelToModel);
  const indexToName = {};
  Object.keys(labelToName).forEach((label) => {
    const match = label.match(/Response\s+(\d+)/);
    if (match) {
      indexToName[Number(match[1]) - 1] = labelToName[label];
    }
  });
  return { labelToName, indexToName };
}

function displayNameForIndex(index, indexToName, labelToModel) {
  if (indexToName[index]) return indexToName[index];
  const label = `Response ${index + 1}`;
  if (labelToModel?.[label]) {
    return labelToModel[label].split('/')[1] || labelToModel[label];
  }
  return label;
}

function deAnonymizeText(text, labelToDisplayName) {
  if (!labelToDisplayName) return text;

  let result = text;
  const sortedLabels = Object.keys(labelToDisplayName).sort((a, b) => b.length - a.length);

  sortedLabels.forEach((label) => {
    const displayName = labelToDisplayName[label];
    result = result.replace(new RegExp(label, 'g'), `**${displayName}**`);
  });
  return result;
}

function judgeLabelMap(rank, indexToName, labelToName) {
  if (rank?.label_to_index) {
    const mapping = {};
    Object.entries(rank.label_to_index).forEach(([label, idx]) => {
      mapping[label] = indexToName[idx] || `Response ${Number(idx) + 1}`;
    });
    return mapping;
  }
  return labelToName;
}

function scoreLabel(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function ConsensusPanel({ consensus, redTeam, indexToName, labelToModel }) {
  const [critiqueOpen, setCritiqueOpen] = useState(false);

  if (!consensus && !redTeam) return null;

  const level = consensus?.level || 'UNKNOWN';
  const reasons = consensus?.reasons || [];
  const disputed = consensus?.disputed_claims || [];
  const leaderName =
    consensus?.leader_index != null
      ? displayNameForIndex(consensus.leader_index, indexToName, labelToModel)
      : null;

  return (
    <div className={`consensus-panel consensus-${level.toLowerCase()}`}>
      <div className="consensus-header">
        <h4>Council confidence</h4>
        <span className={`confidence-badge confidence-${level.toLowerCase()}`}>
          {level}
        </span>
      </div>
      <p className="stage-description">
        Confidence is the council's internal agreement signal, not a guarantee that the answer is correct.
      </p>
      {leaderName && (
        <p className="consensus-leader">
          Leading candidate: <strong>{leaderName}</strong>
          {consensus.leader_mean_correctness != null && (
            <> · correctness {Number(consensus.leader_mean_correctness).toFixed(1)}/10</>
          )}
          {consensus.top1_agreement != null && (
            <> · top-1 agreement {(consensus.top1_agreement * 100).toFixed(0)}%</>
          )}
        </p>
      )}
      {reasons.length > 0 && (
        <ul className="consensus-reasons">
          {reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      )}
      {disputed.length > 0 && (
        <div className="disputed-claims">
          <strong>Disputed claims</strong>
          <ul>
            {disputed.map((claim, i) => (
              <li key={i}>{claim}</li>
            ))}
          </ul>
        </div>
      )}
      {redTeam && (
        <div className="red-team-block">
          <div className="red-team-header">
            <strong>Red-team review</strong>
            <span className={`verdict-badge verdict-${(redTeam.verdict || '').toLowerCase()}`}>
              {redTeam.verdict || 'n/a'}
              {redTeam.confidence != null ? ` · ${redTeam.confidence}/10` : ''}
            </span>
          </div>
          {redTeam.same_family && (
            <p className="stage-description">
              Reviewer is the same model family as the leader.
            </p>
          )}
          <button
            type="button"
            className="critique-toggle"
            onClick={() => setCritiqueOpen((open) => !open)}
          >
            {critiqueOpen ? 'Hide critique' : 'Show critique'}
          </button>
          {critiqueOpen && redTeam.critique && (
            <div className="red-team-critique markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>
                {redTeam.critique}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Stage2({
  rankings,
  labelToModel,
  aggregateRankings,
  responseRankings,
  topKIndices,
  consensus,
  redTeam,
}) {
  const [activeTab, setActiveTab] = useState(0);

  if (!rankings || rankings.length === 0) {
    return null;
  }

  const { labelToName, indexToName } = getIndexToDisplayName(labelToModel);
  const active = rankings[activeTab] || rankings[0];
  const judgeMap = judgeLabelMap(active, indexToName, labelToName);
  const topK = (topKIndices || []).map((idx) => {
    const row = (responseRankings || []).find((item) => item.index === idx);
    return { index: idx, row };
  });

  return (
    <div className="stage stage2">
      <h3 className="stage-title">Stage 2: Peer Rankings</h3>

      <h4>Raw Evaluations</h4>
      <p className="stage-description">
        Each model evaluated anonymized responses (Response 1, 2, 3, …) after excluding its own family when possible.
        Below, model names are shown in <strong>bold</strong> for readability; the original evaluation used anonymous labels.
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
          {active.model}
          {active.self_excluded && (
            <span className="self-exclusion-note"> · own family excluded</span>
          )}
        </div>
        <div className="ranking-content markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>
            {deAnonymizeText(active.ranking, judgeMap)}
          </ReactMarkdown>
        </div>

        {active.parsed_ranking && active.parsed_ranking.length > 0 && (
          <div className="parsed-ranking">
            <strong>Extracted Ranking:</strong>
            <ol>
              {active.parsed_ranking.map((label, i) => {
                const idx = active.label_to_index?.[label];
                const name =
                  idx != null
                    ? displayNameForIndex(idx, indexToName, labelToModel)
                    : (judgeMap[label] || label);
                const corr =
                  idx != null
                    ? (active.correctness?.[idx] ?? active.correctness?.[String(idx)])
                    : null;
                return (
                  <li key={i}>
                    {name}
                    {corr != null && (
                      <span className="judge-correctness"> · {Number(corr).toFixed(1)}/10</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {active.disputed_claims && active.disputed_claims.length > 0 && (
          <div className="judge-disputed">
            <strong>Disputed claims from this judge:</strong>
            <ul>
              {active.disputed_claims.map((claim, i) => (
                <li key={i}>{deAnonymizeText(claim, judgeMap).replace(/\*\*/g, '')}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="copy-row">
          <CopyButton
            text={deAnonymizeText(active.ranking, judgeMap).replace(/\*\*/g, '')}
            label="Copy ranking"
          />
        </div>
      </div>

      {aggregateRankings && aggregateRankings.length > 0 && (
        <div className="aggregate-rankings">
          <h4>Aggregate Rankings (Street Cred)</h4>
          <p className="stage-description">
            Macro average across each model's samples (higher score is better):
          </p>
          <div className="aggregate-list">
            {aggregateRankings.map((agg, index) => (
              <div key={index} className="aggregate-item">
                <span className="rank-position">#{index + 1}</span>
                <span className="rank-model">
                  {agg.model.split('/')[1] || agg.model}
                </span>
                <span className="rank-score">
                  {agg.score != null
                    ? `Score: ${scoreLabel(agg.score)}`
                    : agg.average_rank != null
                      ? `Avg: ${Number(agg.average_rank).toFixed(2)}`
                      : 'Score: —'}
                </span>
                {agg.mean_correctness != null && (
                  <span className="rank-score">
                    Correctness: {Number(agg.mean_correctness).toFixed(1)}
                  </span>
                )}
                <span className="rank-count">
                  ({agg.rankings_count} samples)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topK.length > 0 && (
        <div className="topk-candidates">
          <h4>Top-K candidates for chairman</h4>
          <p className="stage-description">
            These anonymized answers are the base draft plus supporting edits for Stage 3.
          </p>
          <div className="aggregate-list">
            {topK.map(({ index, row }, i) => (
              <div key={index} className="aggregate-item">
                <span className="rank-position">#{i + 1}</span>
                <span className="rank-model">
                  {displayNameForIndex(index, indexToName, labelToModel)}
                </span>
                <span className="rank-score">
                  Score: {scoreLabel(row?.score)}
                </span>
                {row?.mean_correctness != null && (
                  <span className="rank-score">
                    Correctness: {Number(row.mean_correctness).toFixed(1)}
                  </span>
                )}
                {row?.top1_votes != null && (
                  <span className="rank-count">({row.top1_votes} top-1)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConsensusPanel
        consensus={consensus}
        redTeam={redTeam}
        indexToName={indexToName}
        labelToModel={labelToModel}
      />
    </div>
  );
}
