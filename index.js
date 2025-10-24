import http from 'k6/http';
import { sleep, check } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 },   // warm-up
    { duration: '5m', target: 500 },   // ramp up
    { duration: '10m', target: 1000 }, // steady 1000 concurrent users
    { duration: '3m', target: 0 },     // cool down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],   // <5% errors
    http_req_duration: ['p(95)<1500'],// p95 latency <1.5s
  },
};

const TARGET = __ENV.TARGET || 'https://botech.ma';
const endpoints = ['/', '/contact', '/produits', '/about-us', '/blog'];

export default function () {
  const url = TARGET + endpoints[Math.floor(Math.random() * endpoints.length)];
  let res = http.get(url);

  check(res, { 'status 200/301/302': (r) => [200,301,302].includes(r.status) });
  sleep(Math.random() * 2);
}
