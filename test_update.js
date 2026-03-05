require('dotenv').config();
const { setLivreurStatus } = require('./services/database');
async function test() {
   try {
     console.log('Testing setLivreurStatus...');
     await setLivreurStatus('5176746955', 'telegram', true);
     console.log('Done');
   } catch(e) {
     console.error(e);
   }
}
test();
