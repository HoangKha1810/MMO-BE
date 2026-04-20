import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`BE listening on http://localhost:${port}`);
});
