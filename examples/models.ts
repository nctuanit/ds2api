import Deepseek from '../dist/index.mjs';

const client = new Deepseek({
  apiKey: `opKAYFDJ1reQts/5CD1ZX0/RdPd9xatDx5y0y+NKvYMeVhhCw90Ow40PTo61tlNY`,
});

console.log(await client.models.list());
