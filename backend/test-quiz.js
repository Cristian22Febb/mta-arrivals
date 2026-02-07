// Quick test script for quiz endpoints
const http = require('http');

const BASE_URL = 'http://localhost:3001';

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    
    const req = http.request(`${BASE_URL}${path}`, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

async function test() {
  console.log('🧪 Testing Quiz API...\n');
  
  // Test 1: Get today's quiz
  console.log('1. GET /quiz/daily');
  const dailyQuiz = await makeRequest('/quiz/daily');
  console.log(`   Status: ${dailyQuiz.status}`);
  console.log(`   Question: ${dailyQuiz.data.question}`);
  console.log(`   Answer Length: ${dailyQuiz.data.answerLength}`);
  console.log(`   Category: ${dailyQuiz.data.category}\n`);
  
  // Test 2: Submit a correct answer
  console.log('2. POST /quiz/submit (correct answer)');
  const submit = await makeRequest('/quiz/submit', 'POST', {
    device: 'ESP-TEST',
    name: 'Test Device',
    answer: 'ZEBRA',  // Today's answer (2026-02-04)
    time: 23.5
  });
  console.log(`   Status: ${submit.status}`);
  console.log(`   Correct: ${submit.data.correct}`);
  console.log(`   Rank: ${submit.data.rank}`);
  console.log(`   Message: ${submit.data.message}\n`);
  
  // Test 3: Get leaderboard
  console.log('3. GET /quiz/leaderboard');
  const leaderboard = await makeRequest('/quiz/leaderboard');
  console.log(`   Status: ${leaderboard.status}`);
  console.log(`   Entries: ${leaderboard.data.entries.length}`);
  if (leaderboard.data.entries.length > 0) {
    console.log('   Top entry:', leaderboard.data.entries[0]);
  }
  console.log('');
  
  // Test 4: Check device status
  console.log('4. GET /quiz/status/ESP-TEST');
  const status = await makeRequest('/quiz/status/ESP-TEST');
  console.log(`   Status: ${status.status}`);
  console.log(`   Available: ${status.data.available}`);
  console.log(`   Completed: ${status.data.completed}\n`);
  
  console.log('✅ All tests completed!');
}

test().catch(console.error);
