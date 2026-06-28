require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const fs = require('fs');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

if (!fs.existsSync('./data')) fs.mkdirSync('./data');
function load(f,d){try{return JSON.parse(fs.readFileSync(f,'utf-8'));}catch{return d;}}
function save(f,data){fs.writeFileSync(f,JSON.stringify(data,null,2));}

let users=load('./data/users.json',{});
let sessions=load('./data/sessions.json',{});
let reservations=load('./data/reservations.json',[]);

const PURPOSES=['現車確認','買取査定','車検','整備','修理','板金塗装','保険','相談'];

async function getUser(userId){
  if(users[userId])return users[userId];
  try{
    const p=await client.getProfile(userId);
    users[userId]={userId,displayName:p.displayName,pictureUrl:p.pictureUrl||'',name:'',phone:'',car:'',isRegistered:false};
    save('./data/users.json',users);
    return users[userId];
  }catch(e){
    users[userId]={userId,displayName:'',pictureUrl:'',name:'',phone:'',car:'',isRegistered:false};
    save('./data/users.json',users);
    return users[userId];
  }
}

app.use('/webhook', express.raw({type: '*/*'}));

app.post('/webhook',(req,res)=>{
  const signature=req.headers['x-line-signature'];
  if(!line.validateSignature(req.body,config.channelSecret,signature)){
    return res.status(403).send('Forbidden');
  }
  const body=JSON.parse(req.body);
  Promise.all((body.events||[]).map(handleEvent))
    .then(()=>res.json({status:'ok'}))
    .catch(err=>{console.error(err);res.status(500).end();});
});

async function handleEvent(event){
  if(event.type!=='message'||event.message.type!=='text')return;
  const userId=event.source.userId;
  const text=event.message.text.trim();
  const user=await getUser(userId);
  let s=sessions[userId]||{step:0};

  if(text==='キャンセル'){delete sessions[userId];save('./data/sessions.json',sessions);return reply(event.replyToken,'キャンセルしました。「予約」で再開できます。');}
  if(text==='情報変更'){sessions[userId]={step:'edit_name'};save('./data/sessions.json',sessions);return reply(event.replyToken,`現在:\n👤${user.name}\n📞${user.phone}\n🚗${user.car}\n\n新しいお名前を入力してください。`);}
  if(s.step==='edit_name'){user.name=text;save('./data/users.json',users);sessions[userId]={step:'edit_phone'};save('./data/sessions.json',sessions);return reply(event.replyToken,'電話番号を入力してください。');}
  if(s.step==='edit_phone'){user.phone=text;save('./data/users.json',users);sessions[userId]={step:'edit_car'};save('./data/sessions.json',sessions);return reply(event.replyToken,'車種を入力してください。（なければ「なし」）');}
  if(s.step==='edit_car'){user.car=text==='なし'?'':text;user.isRegistered=true;save('./data/users.json',users);delete sessions[userId];save('./data/sessions.json',sessions);return reply(event.replyToken,`✅更新しました！`);}

  if(s.step===0||text==='予約'){sessions[userId]={step:1};save('./data/sessions.json',sessions);return replyQuick(event.replyToken,'ご来店の目的を選んでください',PURPOSES.map(p=>({label:p,text:p})));}
  if(s.step===1){sessions[userId]={...s,step:2,purpose:text};save('./data/sessions.json',sessions);return replyQuick(event.replyToken,'ご希望の日付を選んでください（日曜定休）',buildDates());}
  if(s.step===2){sessions[userId]={...s,step:3,date:text};save('./data/sessions.json',sessions);return replyQuick(event.replyToken,'ご希望の時間を選んでください（1時間枠）',['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00'].map(t=>({label:t,text:t})));}
  if(s.step===3){sessions[userId]={...s,step:user.isRegistered?'confirm':4,time:text};save('./data/sessions.json',sessions);if(user.isRegistered)return replyConfirm(event.replyToken,sessions[userId],user);return reply(event.replyToken,'お名前を入力してください。');}
  if(s.step===4){user.name=text;save('./data/users.json',users);sessions[userId]={...s,step:5};save('./data/sessions.json',sessions);return reply(event.replyToken,'電話番号を入力してください。');}
  if(s.step===5){user.phone=text;save('./data/users.json',users);sessions[userId]={...s,step:6};save('./data/sessions.json',sessions);return reply(event.replyToken,'車種を入力してください。（なければ「なし」）');}
  if(s.step===6){user.car=text==='なし'?'':text;user.isRegistered=true;save('./data/users.json',users);sessions[userId]={...s,step:'confirm'};save('./data/sessions.json',sessions);return replyConfirm(event.replyToken,sessions[userId],user);}
  if(s.step==='confirm'){
    if(text==='予約する'){const endH=parseInt(s.time)+1;const b={userId,date:s.date,time:s.time,endTime:`${endH}:00`,purpose:s.purpose,name:user.name,phone:user.phone,car:user.car,createdAt:new Date().toISOString()};reservations.push(b);save('./data/reservations.json',reservations);delete sessions[userId];save('./data/sessions.json',sessions);return reply(event.replyToken,`✅予約完了！\n\n${user.name}様\n📅${s.date}\n🕐${s.time}〜${endH}:00\n🚗${s.purpose}${user.car?`（${user.car}）`:''}\n\n前日18時にリマインドします。`);}
    if(text==='やり直す'){delete sessions[userId];save('./data/sessions.json',sessions);return reply(event.replyToken,'キャンセルしました。');}
  }
  return reply(event.replyToken,'「予約」と送信すると来店予約を開始できます。');
}

function reply(token,text){return client.replyMessage(token,{type:'text',text});}
function replyQuick(token,text,items){return client.replyMessage(token,{type:'text',text,quickReply:{items:items.slice(0,13).map(i=>({type:'action',action:{type:'message',label:i.label,text:i.text}}))}});}
function replyConfirm(token,s,user){const endH=parseInt(s.time)+1;return client.replyMessage(token,{type:'text',text:`【予約確認】\n📋${s.purpose}\n📅${s.date}\n🕐${s.time}〜${endH}:00\n👤${user.name}様\n📞${user.phone}\n🚗${user.car||'なし'}\n\nよろしいですか？`,quickReply:{items:[{type:'action',action:{type:'message',label:'予約する',text:'予約する'}},{type:'action',action:{type:'message',label:'やり直す',text:'やり直す'}}]}});}
function buildDates(){const dw=['日','月','火','水','木','金','土'];const now=new Date();const items=[];for(let i=1;items.length<7;i++){const d=new Date(now);d.setDate(now.getDate()+i);if(d.getDay()===0)continue;const lbl=`${d.getMonth()+1}/${d.getDate()}(${dw[d.getDay()]})`;items.push({label:lbl,text:lbl});}return items;}

cron.schedule('0 18 * * *',async()=>{const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);const dw=['日','月','火','水','木','金','土'];const label=`${tomorrow.getMonth()+1}/${tomorrow.getDate()}(${dw[tomorrow.getDay()]})`;const targets=reservations.filter(r=>r.date===label);for(const r of targets){await client.pushMessage(r.userId,{type:'text',text:`🔔明日のリマインド\n\n${r.name}様\n📅${r.date}\n🕐${r.time}〜${r.endTime}\n🚗${r.purpose}`}).catch(console.error);}},{timezone:'Asia/Tokyo'});

app.get('/admin/reservations',(req,res)=>res.json({count:reservations.length,reservations}));
app.get('/admin/users',(req,res)=>res.json({count:Object.keys(users).length,users}));
app.get('/',(req,res)=>res.send('Bot running!'));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Bot起動 port:${PORT}`));
