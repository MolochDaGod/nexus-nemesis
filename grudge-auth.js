/** grudge-auth.js — Unified Grudge Auth: https://id.grudge-studio.com */
export const GRUDGE_AUTH_URL='https://id.grudge-studio.com/auth';
export const GRUDGE_API_URL='https://id.grudge-studio.com';
export function getGrudgeToken(){return localStorage.getItem('grudge_auth_token')||null;}
export function getGrudgeUser(){const t=getGrudgeToken();if(!t)return null;return{token:t,userId:localStorage.getItem('grudge_user_id')||null,grudgeId:localStorage.getItem('grudge_id')||null,username:localStorage.getItem('grudge_username')||'Player'};}
export function isGrudgeAuthenticated(){return!!getGrudgeToken();}
export function redirectToGrudgeGateway(r){window.location.href=`${GRUDGE_AUTH_URL}?redirect=${encodeURIComponent(r||window.location.href)}&app=nemesis`;}
export function requireGrudgeAuth(r){if(!isGrudgeAuthenticated())redirectToGrudgeGateway(r);}
export function grudgeSignOut(){['grudge_auth_token','grudge_user_id','grudge_id','grudge_username','grudge_session_token','grudge-session','grudge_auth_provider'].forEach(k=>localStorage.removeItem(k));}
export function grudgeAuthHeaders(){const t=getGrudgeToken();return t?{Authorization:`Bearer ${t}`,'Content-Type':'application/json'}:{'Content-Type':'application/json'};}
// Auto-consume returning token from hash fragment
(function(){if(!location.hash||!location.hash.includes('token='))return;const h=new URLSearchParams(location.hash.slice(1));const t=h.get('token');if(!t)return;localStorage.setItem('grudge_auth_token',t);if(h.get('grudgeId'))localStorage.setItem('grudge_id',h.get('grudgeId'));if(h.get('name'))localStorage.setItem('grudge_username',h.get('name'));history.replaceState(null,'',location.pathname+location.search);})();
