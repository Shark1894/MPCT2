// Direct database access for e2e seeding, where the API alone can't set the state up.
// Reviews of a line that isn't due yet leave its streak alone, so seeding several clean
// reviews in a row needs the line made due in between.
// Set MPCT_DB to the server's database URL, e.g. postgresql://postgres@localhost:5432/mpct_e2e
const { execFileSync } = require('child_process');

function makeDue(ids) {
  const url = (process.env.MPCT_DB || '').replace('+psycopg', '');
  if (!url) throw new Error('Set MPCT_DB to the database URL to seed review history');
  const list = ids.map((id) => Number(id)).filter(Number.isInteger);
  if (!list.length) return;
  execFileSync('psql', [url, '-q', '-c', `UPDATE lines SET next_review_on = CURRENT_DATE WHERE id IN (${list.join(',')})`]);
}

module.exports = { makeDue };
