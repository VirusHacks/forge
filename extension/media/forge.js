(() => {
  const vscode=acquireVsCodeApi(),app=document.getElementById('app');
  let state={runs:[],models:[],workspace:'No workspace'},pending=null,streamNode=null,streamText='',scrollPinned=true,renderTimer=0,activityNode=null,activityList=null,activitySummary=null,activityCount=0,liveStatus=null;
  const send=message=>vscode.postMessage(message);
  function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;}
  function button(text,fn,cls,label){const b=el('button',cls,text);b.type='button';if(label)b.setAttribute('aria-label',label);b.addEventListener('click',fn);return b;}
  function inlineMarkdown(target,text){
    const pattern=/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;let cursor=0,match;
    while((match=pattern.exec(text))){target.append(document.createTextNode(text.slice(cursor,match.index)));const token=match[0];target.append(el(token.startsWith('**')?'strong':'code','',token.startsWith('**')?token.slice(2,-2):token.slice(1,-1)));cursor=match.index+token.length;}
    target.append(document.createTextNode(text.slice(cursor)));
  }
  function markdown(container,text){
    container.replaceChildren();const parts=String(text).split(/```/);
    parts.forEach((part,i)=>{
      if(i%2){const block=el('div','code'),code=part.replace(/^[^\n]*\n/,'');block.append(button('Copy',()=>send({type:'copy',text:code.slice(0,12000)}),'copy'),document.createTextNode(code));container.append(block);return;}
      const lines=part.split('\n');lines.forEach((line,index)=>{const heading=/^(#{1,3})\s+(.+)$/.exec(line),list=/^\s*[-*]\s+(.+)$/.exec(line);const item=el(heading?'strong':'span',heading?'markdown-heading':'');if(list)item.append(document.createTextNode('• '));inlineMarkdown(item,heading?heading[2]:list?list[1]:line);container.append(item);if(index<lines.length-1)container.append(document.createTextNode('\n'));});
    });
  }
  const run=()=>state.runs.find(r=>r.id===state.current);
  function eventText(e){
    switch(e.type){
      case 'tool.start':return ({investigate_repository:'Finding relevant files',search_repository:'Searching the repository',search_directory:'Exploring folders',read_file:'Reading source',stage_edit:'Preparing an edit',validate_edits:'Running checks',submit_review:'Preparing your review',get_run_state:'Restoring task context',find_symbols:'Finding symbols',get_symbol_context:'Reading symbol context',trace_symbol:'Tracing related code'})[e.name]||`Using ${e.name}`;
      case 'search.fallback':return 'Using local search';
      case 'context.symbol_search':return 'Symbols: '+(e.results||[]).map(x=>`${x.name} · ${x.file}:${x.line}`).join(' | ');
      case 'context.investigation':{const groups=e.selected||{};const items=Object.values(groups).flat();return items.length?'Selected: '+items.map(x=>`${x.path}${x.reason?' · '+x.reason:''}`).join(' | '):'Selected relevant files';}
      case 'context':return `Read ${e.file}${e.reason?' · '+e.reason:''}`;
      case 'validation':return e.ok?'Checks passed':`Checks failed${e.summary?' · '+e.summary:''}`;
      case 'model.attempt':return `Using ${e.model}`;
      case 'model.fallback':return `Switching to ${e.to||'another model'}${e.kind?' · '+String(e.kind).replace(/_/g,' '):''}`;
      case 'model.retry':return 'Retrying the model';
      case 'model.skip':return `Skipped ${e.model}`;
      case 'stage':return `Proposed a change in ${e.path}`;
      case 'usage.completed':return `${e.input??0} input · ${e.output??0} output tokens`;
      case 'session':return `Session ${e.session}`;
      case 'tool.error':return `Tool stopped: ${e.message||e.name}`;
      case 'checkpoint.error':return 'Could not save the recovery checkpoint';
      case 'review':return e.applied?'Changes reviewed':'Review declined';
      default:return '';
    }
  }
  function currentActivityLabel(){const current=run();return current?.status==='running'?'Working':'Activity';}
  function updateActivitySummary(){if(activitySummary)activitySummary.textContent=`${currentActivityLabel()}${activityCount?' · '+activityCount+' steps':''}`;}
  function addEvent(feed,e){
    if(e.type==='delta'){
      if(!streamNode){const b=el('section','assistant-message');streamNode=el('div','assistant-text');b.append(streamNode);feed.append(b);streamText='';}
      streamText+=String(e.text||'');if(!renderTimer)renderTimer=requestAnimationFrame(()=>{renderTimer=0;if(streamNode)markdown(streamNode,streamText);});return;
    }
    if(streamNode){if(renderTimer){cancelAnimationFrame(renderTimer);renderTimer=0;}markdown(streamNode,streamText);}streamNode=null;streamText='';
    if(e.type==='error'||e.type==='status'){if(e.type==='status'&&e.status==='error')feed.append(el('div','error-message',e.message||'The run stopped.'));return;}
    const text=eventText(e);if(!text)return;
    if(liveStatus&&e.type!=="usage.completed"&&e.type!=="session")liveStatus.textContent=text+"…";
    if(!activityNode){activityNode=el('details','thinking');activitySummary=el('summary','thinking-title');activityList=el('div','thinking-list');activityNode.append(activitySummary,activityList);feed.append(activityNode);}
    activityList.append(el('div','thinking-item',text));activityCount++;updateActivitySummary();
  }
  function showReview(feed){
    if(!pending||pending.runId!==state.current)return;
    const box=el('section','review');box.append(el('strong','','Review changes'),el('p','muted','Review the open diff tabs. Selected hunks are checked again before applying.'));
    const checks=pending.hunks.map(h=>{const label=el('label','hunk'),input=el('input');input.type='checkbox';input.checked=true;label.append(input,document.createTextNode(`${h.path}:${h.line} · hunk ${h.index+1}`));box.append(label);return input;});
    const actions=el('div','actions');actions.append(button('Approve selected',()=>{const indices=checks.flatMap((c,i)=>c.checked?[i]:[]);send({type:'decision',runId:pending.runId,digest:pending.digest,indices});pending=null;render();},'primary'),button('Reject',()=>{send({type:'decision',runId:pending.runId,digest:pending.digest,indices:[]});pending=null;render();},'quiet'));box.append(actions);feed.append(box);
  }
  function render(){
    const old=document.querySelector('textarea');const draft=old?old.value:(vscode.getState()?.draft||''),atBottom=scrollPinned;
    streamNode=null;streamText='';activityNode=null;activityList=null;activitySummary=null;activityCount=0;liveStatus=null;if(renderTimer){cancelAnimationFrame(renderTimer);renderTimer=0;}app.replaceChildren();
    const top=el('header','top'),brand=el('div','brand');brand.append(el('span','brand-mark','✳'),el('span','','Forge'));top.append(brand);
    const work=el('div','workspace',state.workspace);top.append(work);
    if(state.runs.length){const history=el('select','history');history.setAttribute('aria-label','Session history');state.runs.slice().reverse().forEach(r=>{const option=el('option','',`${r.task.slice(0,48)} · ${r.status}`);option.value=r.id;option.selected=r.id===state.current;history.append(option);});history.addEventListener('change',()=>send({type:'history',runId:history.value}));top.append(history);}app.append(top);
    const feed=el('div','feed');feed.setAttribute('role','log');feed.setAttribute('aria-live','polite');feed.setAttribute('aria-label','Agent conversation and activity');feed.addEventListener('scroll',()=>{scrollPinned=feed.scrollHeight-feed.scrollTop-feed.clientHeight<50;});const current=run();
    if(!current){const empty=el('section','empty');empty.append(el('div','empty-mark','✳'),el('h2','','What would you like to build?'),el('p','','Forge can search the workspace, propose changes and run checks.'),button('Use Task B request',()=>{const t=document.querySelector('textarea');t.value=state.taskExample;t.focus();vscode.setState({...vscode.getState(),draft:t.value});},'suggestion'));feed.append(empty);}
    else{const user=el('section','user-message');user.append(document.createTextNode(current.task));feed.append(user);if(current.status==='running')liveStatus=el('div','live-status','Working…');current.events.forEach(e=>addEvent(feed,e));if(liveStatus)feed.append(liveStatus);showReview(feed);if(current.status!=='running')feed.append(el('div','end-status',({complete:'Completed',cancelled:'Cancelled',rejected:'Proposal rejected',error:'Stopped'})[current.status]||current.status));if(current.status==='error'&&!state.runs.some(r=>r.status==='running'))feed.append(button('Continue task',()=>send({type:'start',task:'please continue',model:current.model}),'text-button'));}
    const announce=el('div','screen-reader-announcement',current?`Run ${current.status}`:'Ready');announce.setAttribute('aria-live','polite');announce.setAttribute('aria-atomic','true');app.append(announce,feed);if(atBottom)feed.scrollTop=feed.scrollHeight;
    const composer=el('div','composer'),box=el('div','composer-box'),input=el('textarea');input.placeholder='Ask Forge to make a change…';input.setAttribute('aria-label','Task');input.value=draft;input.addEventListener('input',()=>vscode.setState({...vscode.getState(),draft:input.value}));box.append(input);
    const toolbar=el('div','composer-toolbar'),left=el('div','tools');left.append(button('+',()=>send({type:'attach'}),'icon-button','Attach a workspace file'),button('@',()=>send({type:'symbol'}),'icon-button','Attach a workspace symbol'));
    const model=el('select','model');model.setAttribute('aria-label','TrueForge model');if(!state.models.length)model.append(el('option','','No models available'));state.models.forEach(name=>{const o=el('option','',name);o.value=name;model.append(o);});const stored=vscode.getState()?.model;if(stored&&state.models.includes(stored))model.value=stored;else if(state.models.includes('google-gemini/gemini-3-5-flash-lite'))model.value='google-gemini/gemini-3-5-flash-lite';model.addEventListener('change',()=>vscode.setState({draft:input.value,model:model.value}));left.append(model);toolbar.append(left);
    const busy=state.runs.some(r=>r.status==='running');const action=busy?button('Stop',()=>{const active=state.runs.find(r=>r.status==='running');send({type:'stop',runId:active.id});},'stop-button'):button('Send',()=>{if(!input.value.trim())return;send({type:'start',task:input.value,model:model.value});input.value='';vscode.setState({draft:'',model:model.value});},'send-button');toolbar.append(action);box.append(toolbar);composer.append(box);
    input.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!busy){e.preventDefault();action.click();}});
    const footer=el('div','composer-footer');footer.append(el('span','muted',state.modelError||'Flask benchmark · ⌘ Enter to send'),button('↻',()=>send({type:'models'}),'refresh-button','Refresh models'),button('Undo',()=>send({type:'undo'}),'text-button'));composer.append(footer);app.append(composer);
  }
  window.addEventListener('message',({data})=>{if(!data||typeof data.type!=='string')return;
    if(data.type==='state'){state=data;render();}
    else if(data.type==='event'){const r=state.runs.find(x=>x.id===data.runId);if(!r)return;const e=data.event;if(e.type==='delta'&&r.events.at(-1)?.type==='delta')r.events.at(-1).text+=e.text||'';else r.events.push(e);if(data.runId===state.current){const feed=document.querySelector('.feed');addEvent(feed,e);if(scrollPinned)feed.scrollTop=feed.scrollHeight;}}
    else if(data.type==='review'){pending=data;render();}
    else if(data.type==='attachment'){const t=document.querySelector('textarea');t.value+=(t.value?'\n':'')+data.text;t.focus();vscode.setState({...vscode.getState(),draft:t.value});}
    else if(data.type==='notice'){const feed=document.querySelector('.feed');feed.append(el('div','error-message',data.text));}
  });
  send({type:'ready'});
})();
