import {useEffect,useRef} from 'react';
import {Picker as PickerControl} from '../picker.js';
export default function Picker({id,label,options,value,onChange}){
 const optionsKey=JSON.stringify(options);
 const element=useRef(null),control=useRef(null),change=useRef(onChange);change.current=onChange;
 useEffect(()=>{const el=element.current;control.current=new PickerControl(el,{label,options});el.value=value;const listener=()=>change.current(el.value);el.addEventListener('change',listener);return()=>{el.removeEventListener('change',listener);control.current.destroy();};},[id,label]);
 useEffect(()=>{control.current?.setOptions(options);if(control.current)element.current.value=value;},[optionsKey]);
 useEffect(()=>{if(control.current)element.current.value=value;},[value]);
 return <div id={id} className="picker" ref={element}/>;
}
