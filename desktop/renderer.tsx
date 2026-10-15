import {Component,useEffect,useState,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import Console from '../app/console';
import '../app/globals.css';
import '../app/market.css';
import './style.css';
class Boundary extends Component<{children:ReactNode},{error:string}> {
  state={error:''};
  static getDerivedStateFromError(){return {error:'The interface could not load. Restart the application or restore your configuration backup.'};}
  render(){return this.state.error?<div className="desktop-error"><h1>Vigilant Engine</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>Reload interface</button></div>:this.props.children;}
}
function DesktopStatus(){
  const [stats,setStats]=useState<{averageMs:number,active:number,requests:number}|null>(null);
  useEffect(()=>{let live=true;const check=async()=>{try{const r=await fetch('/api/desktop/health'),d=await r.json() as {network:{averageMs:number,active:number,requests:number}};if(live&&r.ok)setStats(d.network);}catch{if(live)setStats(null);}};void check();const timer=setInterval(check,5000);return()=>{live=false;clearInterval(timer);};},[]);
  return <div className="desktop-status"><b><span className={stats?'desktop-dot':''}/>VIGILANT ENGINE <small>WINDOWS DESKTOP</small></b><span>Solana · BSC · Arbitrum One</span><span>{stats?`${stats.active} active · ${stats.requests} requests${stats.requests?' · '+stats.averageMs+' ms average':''}`:'Starting local backend…'}</span></div>;
}
createRoot(document.getElementById('root')!).render(<Boundary><DesktopStatus/><Console/></Boundary>);
