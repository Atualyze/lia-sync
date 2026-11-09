import fs from 'node:fs/promises'; import path from 'node:path';
const mask = (p='') => { const s=String(p); return s.length>7 ? `${s.slice(0,6)}***${s.slice(-4)}` : '***'; };
export function normalizePhone(raw = '') {
  let p = String(raw || '').trim();
  const isSim = p.startsWith('sim:');
  if (isSim) p = p.slice(4);
  if (p === 'tauan_self') return isSim ? 'sim:tauan_self' : 'tauan_self';
  if (/@lid$/i.test(p)) return isSim ? `sim:${p}` : p;
  const digits = p.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (/^[6-9]/.test(num)) {
      const normalized = `55${ddd}9${num}`;
      return isSim ? `sim:${normalized}` : normalized;
    }
  }
  if (digits.length === 10 && !digits.startsWith('55')) {
    const ddd = digits.slice(0, 2);
    const num = digits.slice(2);
    if (/^[6-9]/.test(num)) {
      const normalized = `55${ddd}9${num}`;
      return isSim ? `sim:${normalized}` : normalized;
    }
  }
  if (digits.length === 11 && !digits.startsWith('55')) {
    const normalized = `55${digits}`;
    return isSim ? `sim:${normalized}` : normalized;
  }
  const result = digits || p;
  return isSim ? `sim:${result}` : result;
}

export function isValidRealMobilePhone(raw = '') {
  if (!raw || typeof raw !== 'string') return false;
  const p = raw.trim();
  if (p.startsWith('sim:') || p.includes('tauan') || /@lid$/i.test(p)) return false;
  const digits = p.replace(/\D/g, '');

  // Rejeita padrões fictícios conhecidos
  if (/(\d)\1{5,}/.test(digits)) return false; // 6 dígitos idênticos seguidos
  if (/(?:999998888|977112233|999990000|12345678|87654321)/.test(digits)) return false;

  // Brasil: deve ter DDI 55 + DDD válido + celular
  if (digits.startsWith('55')) {
    const withoutDdi = digits.slice(2);
    if (withoutDdi.length !== 10 && withoutDdi.length !== 11) return false;
    const ddd = parseInt(withoutDdi.slice(0, 2), 10);
    if (ddd < 11 || ddd > 99) return false;
    const num = withoutDdi.slice(2);
    if (withoutDdi.length === 11 && !num.startsWith('9')) return false;
    if (/^(\d)\1+$/.test(num)) return false;
    return true;
  }

  if (digits.length === 11) {
    const ddd = parseInt(digits.slice(0, 2), 10);
    if (ddd < 11 || ddd > 99) return false;
    const num = digits.slice(2);
    if (!num.startsWith('9')) return false;
    if (/^(\d)\1+$/.test(num)) return false;
    return true;
  }

  return false;
}

export function formatPhoneNumber(raw = '') {
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return raw;
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (num.length === 9) return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
    if (num.length === 8) return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  }
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return raw;
}

export function isTauanContact(target = '', humanPhone = '', cachedOwner = '') {
  if (!target) return false;
  const s = String(target).trim();
  if (s === 'tauan_self' || s === 'tauan' || s.toLowerCase().includes('atualyze')) return true;

  const targetDigits = s.replace(/@.*$/, '').replace(/\D/g, '');
  if (!targetDigits || targetDigits.length < 8) return false;

  // Números conhecidos do Tauan / Atualyze
  const TAUAN_BASE = ['5588921694598', '55889921694598', '5588992023309', '558892023309'];
  for (const t of TAUAN_BASE) {
    if (targetDigits === t || targetDigits.endsWith(t.slice(-8))) return true;
  }

  const candidates = [humanPhone, cachedOwner].filter(Boolean).map(h => String(h).replace(/@.*$/, '').replace(/\D/g, ''));
  for (const cand of candidates) {
    if (!cand || cand.length < 8) continue;
    if (targetDigits === cand) return true;

    // Extrai os últimos 8 dígitos (número do assinante)
    const targetLast8 = targetDigits.slice(-8);
    const candLast8 = cand.slice(-8);
    if (targetLast8 === candLast8) {
      // Extrai DDD de forma consistente
      const targetDdd = targetDigits.startsWith('55') ? targetDigits.slice(2, 4) : (targetDigits.length >= 10 ? targetDigits.slice(0, 2) : '');
      const candDdd = cand.startsWith('55') ? cand.slice(2, 4) : (cand.length >= 10 ? cand.slice(0, 2) : '');
      if (!targetDdd || !candDdd || targetDdd === candDdd) {
        return true;
      }
    }
  }
  return false;
}

export class SessionStore { constructor(file, { now=()=>Date.now(), ttlMs=30*86400000, logger=console }={}) { this.file=file; this.now=now; this.ttlMs=ttlMs; this.logger=logger; this.sessions={}; this.saveTimer=null; this.saving=null; this.queues=new Map(); }
 async load() { try { this.sessions=JSON.parse(await fs.readFile(this.file,'utf8')); if (!this.sessions || typeof this.sessions!=='object' || Array.isArray(this.sessions)) this.sessions={}; } catch(e) { if (e.code==='ENOENT') this.sessions={}; else { const corrupt=`${this.file}.corrupt-${this.now()}`; try { await fs.rename(this.file,corrupt); } catch {} this.logger.error?.(`[sessions] arquivo corrompido preservado: ${corrupt}`); this.sessions={}; } } this.purge(); return this.sessions; }
 purge() { const cutoff=this.now()-this.ttlMs; for(const [key,s] of Object.entries(this.sessions)) { const active=new Date(s.lastUserAt||s.updatedAt||0).getTime(); const human=Boolean(s.human)&&this.now()-active<7*86400000; if(active && active<cutoff && !human) delete this.sessions[key]; } }
 validateKey(phone) { const k=String(phone||''); if(k !== 'tauan_self' && k !== 'sim:tauan_self' && !/^\d{8,15}$/.test(k) && !/^sim:\d{8,15}$/.test(k) && !/^\d+@lid$/i.test(k) && !/^sim:\d+@lid$/i.test(k)) throw new Error('phone inválido'); return k; }
 get(phone, origin='real') { const norm = normalizePhone(phone); const isSim = origin === 'simulation' || norm.startsWith('sim:'); const cleanPhone = norm.replace(/^sim:/, ''); const key = isSim ? `sim:${cleanPhone}` : cleanPhone; this.validateKey(key); return this.sessions[key] ||= { phone: cleanPhone, origin: isSim ? 'simulation' : 'real', history: [], human: false, updatedAt: new Date(this.now()).toISOString() }; }
 touch(s) { s.updatedAt=new Date(this.now()).toISOString(); }
 markDirty() { clearTimeout(this.saveTimer); this.saveTimer=setTimeout(()=>this.flush().catch(()=>{}),500); }
 async flush() { clearTimeout(this.saveTimer); this.saveTimer=null; if(this.saving) return this.saving; this.saving=(async()=>{ try { await fs.mkdir(path.dirname(this.file),{recursive:true}); const tmp=`${this.file}.tmp`; await fs.writeFile(tmp,JSON.stringify(this.sessions,null,2)); await fs.rename(tmp,this.file); } catch(e) { this.logger.error?.('[sessions] falha de gravação',e.message); } finally { this.saving=null; } })(); return this.saving; }
 enqueue(phone, fn) { const norm = normalizePhone(phone); const key=String(norm.replace(/^sim:/, '')); const prior=this.queues.get(key)||Promise.resolve(); const next=prior.catch(()=>{}).then(fn); this.queues.set(key,next.finally(()=>{if(this.queues.get(key)===next)this.queues.delete(key);})); return next; }
 async archive(phone, reason='') { const norm = normalizePhone(phone); const key=this.validateKey(norm); if(key.startsWith('sim:')) { const s=this.sessions[key]; delete this.sessions[key]; this.markDirty(); return s; } const s=this.sessions[key]; if(!s) return null; const archiveDir=path.join(path.dirname(this.file),'archive'); await fs.mkdir(archiveDir,{recursive:true}); const safe=key.replace(/[^0-9]/g,''); await fs.writeFile(path.join(archiveDir,`${safe}-${this.now()}.json`),JSON.stringify({phone:key,reason,archivedAt:new Date(this.now()).toISOString(),session:s},null,2)); delete this.sessions[key]; this.markDirty(); return s; }
}
export { mask };
