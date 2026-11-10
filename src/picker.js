const chevron='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>';
const check='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>';
let openPicker=null;
export class Picker {
  constructor(element,{label,options=[],placeholder=label}) {
    this.el=element;this.label=label;this.options=[];this.selected='';this.cursor=0;
    this.trigger=document.createElement('button');this.trigger.type='button';this.trigger.className='picker-trigger';
    this.trigger.setAttribute('role','combobox');this.trigger.setAttribute('aria-label',label);this.trigger.setAttribute('aria-haspopup','listbox');this.trigger.setAttribute('aria-expanded','false');
    this.text=document.createElement('span');this.text.className='picker-value';this.text.textContent=placeholder;this.trigger.append(this.text);this.trigger.insertAdjacentHTML('beforeend',chevron);
    this.popup=document.createElement('div');this.popup.className='picker-popup';this.popup.id=element.id+'-options';this.popup.setAttribute('popover','manual');this.popup.setAttribute('role','listbox');this.popup.setAttribute('aria-label',label+' options');this.trigger.setAttribute('aria-controls',this.popup.id);
    element.replaceChildren(this.trigger);(element.closest('[role=dialog]')||document.body).append(this.popup);
    Object.defineProperty(element,'value',{get:()=>this.selected,set:value=>this.setValue(value)});
    this.trigger.onclick=()=>this.isOpen?this.close():this.open();
    this.trigger.onkeydown=event=>this.onKey(event);
    this.popup.onpointerdown=event=>event.preventDefault();
    this.abort=new AbortController();const listenOptions={signal:this.abort.signal};
    document.addEventListener('pointerdown',event=>{if(this.isOpen&&!element.contains(event.target)&&!this.popup.contains(event.target))this.close();},listenOptions);
    document.addEventListener('focusin',event=>{if(this.isOpen&&!element.contains(event.target)&&!this.popup.contains(event.target))this.close();},listenOptions);
    window.addEventListener('resize',()=>this.close(),listenOptions);
    document.addEventListener('scroll',event=>{if(this.isOpen&&!this.popup.contains(event.target))this.position();},{capture:true,signal:this.abort.signal});
    this.setOptions(options);
  }
  destroy(){this.close();clearTimeout(this.typeTimer);this.abort.abort();this.popup.remove();}
  get isOpen(){return this.trigger.getAttribute('aria-expanded')==='true';}
  setOptions(options){this.close();this.options=options.map(o=>typeof o==='string'?{value:o,label:o}:o);this.selected=this.options[0]?.value||'';this.render();}
  setValue(value){if(this.options.some(o=>o.value===value)){this.selected=value;this.render();}}
  render(){this.text.textContent=this.options.find(o=>o.value===this.selected)?.label||this.label;this.popup.replaceChildren();this.buttons=[];
    for(const [index,option] of this.options.entries()){
      const button=document.createElement('div');button.className='picker-option';button.id=this.el.id+'-option-'+index;button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.value===this.selected));button.setAttribute('aria-label',option.label+(option.detail?' — '+option.detail:''));
      const content=document.createElement('span');content.className='option-content';const name=document.createElement('span');name.textContent=option.label;content.append(name);
      if(option.detail){const detail=document.createElement('small');detail.textContent=option.detail;content.append(detail);}
      button.append(content);button.insertAdjacentHTML('beforeend',check);button.onclick=()=>this.choose(index);button.onpointermove=()=>this.highlight(index,false);this.popup.append(button);this.buttons.push(button);
    }
  }
  open(){if(!this.options.length)return;if(openPicker&&openPicker!==this)openPicker.close();openPicker=this;this.popup.showPopover();this.trigger.setAttribute('aria-expanded','true');this.position();this.highlight(Math.max(0,this.options.findIndex(o=>o.value===this.selected)));}
  position(){const rect=this.trigger.getBoundingClientRect();const width=Math.min(Math.max(rect.width,this.el.id==='category'?310:240),innerWidth-24);const below=innerHeight-rect.bottom-16,above=rect.top-16;const useAbove=below<210&&above>below;this.popup.style.width=width+'px';this.popup.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';this.popup.style.maxHeight=Math.min(390,useAbove?above:below)+'px';this.popup.style.top=useAbove?'auto':(rect.bottom+7)+'px';this.popup.style.bottom=useAbove?(innerHeight-rect.top+7)+'px':'auto';}
  close(){if(!this.isOpen)return;this.popup.hidePopover();this.trigger.setAttribute('aria-expanded','false');this.trigger.removeAttribute('aria-activedescendant');if(openPicker===this)openPicker=null;}
  highlight(index,scroll=true){this.cursor=index;this.buttons.forEach((b,i)=>b.classList.toggle('focused',i===index));const active=this.buttons[index];if(active){this.trigger.setAttribute('aria-activedescendant',active.id);if(scroll)active.scrollIntoView({block:'nearest'});}}
  choose(index){const value=this.options[index]?.value;if(value===undefined)return;const changed=value!==this.selected;this.close();this.setValue(value);this.trigger.focus();if(changed)this.el.dispatchEvent(new Event('change',{bubbles:true}));}
  onKey(event){const key=event.key;if(key==='Tab'){this.close();return;}if(key==='Escape'){if(this.isOpen){event.preventDefault();this.close();}return;}
    if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(key)){event.preventDefault();if(!this.isOpen){this.open();if(key==='Home')this.highlight(0);if(key==='End')this.highlight(this.options.length-1);return;}if(key==='Enter'||key===' '){this.choose(this.cursor);return;}if(key==='Home')this.highlight(0);else if(key==='End')this.highlight(this.options.length-1);else this.highlight((this.cursor+(key==='ArrowDown'?1:-1)+this.options.length)%this.options.length);return;}
    if(key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();if(!this.isOpen)this.open();clearTimeout(this.typeTimer);this.typed=(this.typed||'')+key.toLowerCase();let index=this.options.findIndex(o=>o.label.toLowerCase().startsWith(this.typed));if(index>=0)this.highlight(index);this.typeTimer=setTimeout(()=>this.typed='',600);}
  }
}
