/* واجهة هاني سوفت — لا تُخزّن أسرارًا إدارية في هذا الملف. */
(() => {
  const cfg = window.HANI_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR_PROJECT") && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let sb = null, currentUser = null, profile = null, services = [];
  const money = (n, c="USD") => `${Number(n || 0).toLocaleString(undefined,{maximumFractionDigits:2})} ${c}`;
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),3500)}
  function msg(el, text){if(el)el.textContent=text}
  function authOpen(){ $("#authModal").classList.remove("hidden"); msg($("#authMessage"),""); }
  function authClose(){ $("#authModal").classList.add("hidden"); }
  function authTab(tab){$$(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));$("#loginForm").classList.toggle("hidden",tab!=="login");$("#signupForm").classList.toggle("hidden",tab!=="signup");$("#authTitle").textContent=tab==="login"?"تسجيل الدخول":"إنشاء حساب جديد";msg($("#authMessage"),"")}
  function requireLogin(){if(!currentUser){authOpen();return false}return true}
  async function loadProfile(){
    if(!currentUser){profile=null;return}
    const {data,error}=await sb.from("profiles").select("id,username,display_name,role,permissions,wallet_balance").eq("id",currentUser.id).maybeSingle();
    if(error){console.error(error);return}
    profile=data;
  }
  function can(permission){return !!profile && (profile.role==="owner" || profile.role==="admin" && (profile.permissions||[]).includes(permission))}
  function renderUser(){
    $("#userLabel").textContent=profile?`مرحباً، ${profile.display_name||profile.username}`:"زائر";
    $("#logoutBtn").classList.toggle("hidden",!currentUser);
    $("#admin").classList.toggle("hidden",!(can("manage_services")||can("review_deposits")||can("manage_orders")));
    $("#walletBalance").textContent=profile?money(profile.wallet_balance,cfg.DEFAULT_CURRENCY||"USD"):"—";
    $("#heroBalance").textContent=profile?money(profile.wallet_balance,cfg.DEFAULT_CURRENCY||"USD"):"—";
  }
  async function loadServices(){
    const {data,error}=await sb.from("services").select("id,name,category,description,price,currency,is_active").eq("is_active",true).order("created_at",{ascending:false});
    if(error){console.error(error);$("#serviceGrid").innerHTML='<div class="empty">تعذر تحميل الخدمات. تحقق من schema.sql وسياسات RLS.</div>';return}
    services=data||[];
    $("#serviceGrid").innerHTML=services.length?services.map(s=>`<article class="service-card"><div class="service-icon">${esc((s.category||"HS").slice(0,2))}</div><h3>${esc(s.name)}</h3><p>${esc(s.description||s.category||"خدمة رقمية")}</p><div class="service-foot"><span class="price">${money(s.price,s.currency)}</span><button class="btn outline order-btn" data-id="${s.id}">اطلب الخدمة</button></div></article>`).join(""):'<div class="empty">لا توجد خدمات منشورة حتى الآن.</div>';
    $$(".order-btn").forEach(b=>b.onclick=()=>placeOrder(b.dataset.id));
  }
  async function loadOrders(){
    if(!currentUser){$("#ordersList").innerHTML='<div class="empty">سجّل الدخول لعرض طلباتك.</div>';$("#heroOrders").textContent="—";return}
    const {data,error}=await sb.from("orders").select("id,service_name,amount,currency,status,created_at,admin_note,customer_comment,reply_email,admin_reply").order("created_at",{ascending:false}).limit(30);
    if(error){$("#ordersList").innerHTML='<div class="empty">تعذر تحميل الطلبات.</div>';return}
    $("#heroOrders").textContent=(data||[]).length;
    $("#ordersList").innerHTML=data?.length?data.map(o=>`<div class="list-item"><div class="item-top"><b>${esc(o.service_name)}</b><span class="status">${esc(o.status)}</span></div><span>${money(o.amount,o.currency)} · ${new Date(o.created_at).toLocaleDateString("ar")} · ${o.id.slice(0,8)}</span>${o.admin_reply?`<div class="reply-box"><b>رد الإدارة</b><p>${esc(o.admin_reply)}</p></div>`:'<p class="muted">لم ترد الإدارة على هذا الطلب بعد.</p>'}<form class="order-comment-form stack" data-id="${o.id}"><label>تعليقك على الطلب<textarea name="comment" rows="2" maxlength="2000" placeholder="اكتب استفسارك أو تفاصيل إضافية...">${esc(o.customer_comment||"")}</textarea></label><label>البريد الإلكتروني للرد<input name="email" type="email" maxlength="254" required value="${esc(o.reply_email||currentUser.email||"")}" placeholder="name@example.com"></label><button class="btn outline" type="submit">حفظ التعليق والبريد</button></form>${o.status==="completed"?`<button class="btn outline rate-btn" data-id="${o.id}">قيّم الخدمة</button>`:""}</div>`).join(""):'<div class="empty">لا توجد طلبات بعد.</div>';
    $$(".order-comment-form").forEach(form=>form.onsubmit=async e=>{e.preventDefault();const f=new FormData(form);const {error}=await sb.rpc("submit_order_comment",{p_order_id:form.dataset.id,p_comment:String(f.get("comment")||""),p_reply_email:String(f.get("email")||"").trim()});if(error)toast("تعذر حفظ التعليق: "+error.message);else{toast("تم حفظ تعليقك وبريد الرد");await loadOrders()}});
    $$(".rate-btn").forEach(b=>b.onclick=()=>reviewOrder(b.dataset.id));
  }
  async function loadLedger(){
    if(!currentUser){$("#ledgerList").innerHTML='<div class="empty">سجّل الدخول لعرض الحركات.</div>';return}
    const {data,error}=await sb.from("wallet_transactions").select("id,kind,amount,currency,note,created_at").order("created_at",{ascending:false}).limit(20);
    if(error){$("#ledgerList").innerHTML='<div class="empty">تعذر تحميل الحركات.</div>';return}
    $("#ledgerList").innerHTML=data?.length?data.map(t=>`<div class="list-item"><div class="item-top"><b>${esc(t.kind)}</b><span class="price">${money(t.amount,t.currency)}</span></div><span class="muted">${esc(t.note||"")} · ${new Date(t.created_at).toLocaleString("ar")}</span></div>`).join(""):'<div class="empty">لا توجد حركات مالية.</div>';
  }
  async function loadReviews(){
    const {data,error}=await sb.from("reviews").select("rating,comment,created_at").eq("is_published",true).order("created_at",{ascending:false}).limit(9);
    if(error){console.warn(error);return}
    $("#reviewGrid").innerHTML=data?.length?data.map(r=>`<article class="review"><div class="stars">${"★".repeat(r.rating)}${"☆".repeat(5-r.rating)}</div><p>${esc(r.comment||"تقييم للخدمة")}</p><small class="muted">${"عميل"}</small></article>`).join(""):'<div class="empty">كن أول من يقيّم تجربة استخدام المنصة بعد إتمام طلب.</div>';
  }
  async function loadAdmin(){
    if(can("review_deposits")){
      const {data}=await sb.from("deposit_requests").select("id,user_id,amount,currency,reference,status,created_at").eq("status","pending").order("created_at",{ascending:true}).limit(50);
      $("#depositQueue").innerHTML=data?.length?data.map(d=>`<div class="list-item"><b>${money(d.amount,d.currency)}</b><span class="muted">${esc(d.reference||"بدون مرجع")} · ${new Date(d.created_at).toLocaleString("ar")}</span><button class="btn gold approve-deposit" data-id="${d.id}">اعتماد الشحن بعد التحقق</button></div>`).join(""):'<div class="empty">لا توجد طلبات شحن معلقة.</div>';
      $$(".approve-deposit").forEach(b=>b.onclick=async()=>{const {error}=await sb.rpc("admin_approve_deposit",{p_deposit_id:b.dataset.id});if(error)toast("لم يتم الاعتماد: "+error.message);else{toast("تم اعتماد طلب الشحن");await refresh()}})
    } else $("#depositQueue").innerHTML='<div class="empty">لا تملك صلاحية مراجعة الشحن.</div>';
    if(can("manage_orders")){
      const {data,error:ordersError}=await sb.from("orders").select("id,user_id,service_name,amount,currency,status,created_at,customer_comment,reply_email,admin_reply").order("created_at",{ascending:false}).limit(40);
      $("#adminOrders").innerHTML=ordersError?'<div class="empty">تعذر تحميل الطلبات. نفّذ تحديث قاعدة البيانات أولاً.</div>':data?.length?data.map(o=>`<div class="list-item"><div class="item-top"><b>${esc(o.service_name)}</b><span class="status">${esc(o.status)}</span></div><span>${money(o.amount,o.currency)} · ${o.id.slice(0,8)}</span><p><b>تعليق العميل:</b> ${esc(o.customer_comment||"لا يوجد تعليق")}</p><p><b>بريد الرد:</b> ${esc(o.reply_email||"غير مضاف")}</p><label>الرد الرسمي<textarea class="admin-reply" data-id="${o.id}" rows="3" maxlength="4000" placeholder="اكتب رد الإدارة هنا...">${esc(o.admin_reply||"")}</textarea></label><button class="btn gold save-reply" data-id="${o.id}">حفظ الرد</button><label>حالة الطلب<select class="order-status" data-id="${o.id}"><option value="pending" ${o.status==="pending"?"selected":""}>قيد الانتظار</option><option value="processing" ${o.status==="processing"?"selected":""}>جارٍ العمل</option><option value="completed" ${o.status==="completed"?"selected":""}>مكتمل</option><option value="cancelled" ${o.status==="cancelled"?"selected":""}>ملغي</option></select></label><button class="btn outline save-status" data-id="${o.id}">حفظ الحالة</button></div>`).join(""):'<div class="empty">لا توجد طلبات.</div>';
      $$(".save-reply").forEach(b=>b.onclick=async()=>{const reply=$(`.admin-reply[data-id="${b.dataset.id}"]`).value;const {error}=await sb.rpc("admin_reply_to_order",{p_order_id:b.dataset.id,p_reply:reply});if(error)toast("تعذر حفظ الرد: "+error.message);else{toast("تم حفظ الرد الرسمي");await refresh()}});
      $$(".save-status").forEach(b=>b.onclick=async()=>{const status=$(`.order-status[data-id="${b.dataset.id}"]`).value;const {error}=await sb.rpc("admin_update_order_status",{p_order_id:b.dataset.id,p_status:status,p_note:null});if(error)toast("تعذر تعديل الحالة: "+error.message);else{toast("تم تحديث حالة الطلب");await refresh()}})
    }else $("#adminOrders").innerHTML='<div class="empty">لا تملك صلاحية إدارة الطلبات.</div>';
    $("#serviceForm").classList.toggle("hidden",!can("manage_services"));
  }
  async function refresh(){await loadProfile();renderUser();await Promise.all([loadServices(),loadOrders(),loadLedger(),loadReviews()]);await loadAdmin()}
  async function placeOrder(id){
    if(!requireLogin())return;
    const service=services.find(s=>s.id===id);if(!service)return;
    if(!confirm(`تأكيد طلب ${service.name} بسعر ${money(service.price,service.currency)}؟ سيتم خصم الرصيد عند نجاح الطلب.`))return;
    const {error}=await sb.rpc("create_service_order",{p_service_id:id});
    if(error){toast("لم يتم إنشاء الطلب: "+error.message);return}
    toast("تم إنشاء الطلب وخصم الرصيد بنجاح");await refresh();
  }
  async function reviewOrder(orderId){
    if(!requireLogin())return;
    const rating=Number(prompt("قيّم الخدمة من 1 إلى 5:","5"));if(!Number.isInteger(rating)||rating<1||rating>5){toast("التقييم يجب أن يكون من 1 إلى 5");return}
    const comment=prompt("اكتب تعليقاً مختصراً (اختياري):","")||"";
    const {error}=await sb.rpc("submit_service_review",{p_order_id:orderId,p_rating:rating,p_comment:comment});
    if(error)toast("تعذر حفظ التقييم: "+error.message);else{toast("شكراً لتقييمك");await loadReviews()}
  }
  async function onLogin(e){
    e.preventDefault();if(!sb){toast("أكمل إعداد config.js أولاً");return}
    const f=new FormData(e.currentTarget),identifier=String(f.get("identifier")).trim(),password=String(f.get("password"));
    msg($("#authMessage"),"جارٍ تسجيل الدخول…");
    if(!identifier.includes("@")){
      const {data,error}=await sb.functions.invoke("username-login",{body:{username:identifier.toLowerCase(),password}});
      if(error || !data?.session){msg($("#authMessage"),"فشل الدخول: تحقق من البيانات أو تأكيد البريد.");return}
      const {error:setError}=await sb.auth.setSession(data.session);
      if(setError){msg($("#authMessage"),"تعذر بدء الجلسة. حاول مرة أخرى.");return}
    } else {
      const {error}=await sb.auth.signInWithPassword({email:identifier,password});
      if(error){msg($("#authMessage"),"فشل الدخول: تحقق من البيانات أو تأكيد البريد.");return}
    }
    authClose();e.currentTarget.reset();await refresh();toast("تم تسجيل الدخول");
  }
  async function onSignup(e){
    e.preventDefault();if(!sb){toast("أكمل إعداد config.js أولاً");return}
    const f=new FormData(e.currentTarget),username=String(f.get("username")).toLowerCase(),email=String(f.get("email")).trim().toLowerCase(),password=String(f.get("password"));
    msg($("#authMessage"),"جارٍ إنشاء الحساب…");
    const {data,error}=await sb.auth.signUp({email,password,options:{data:{username,display_name:username}}});
    if(error){msg($("#authMessage"),"تعذر إنشاء الحساب: "+error.message);return}
    if(data.session){authClose();await refresh();toast("تم إنشاء الحساب")}else msg($("#authMessage"),"تم إنشاء الحساب. افتح بريدك لتأكيده، ثم سجّل الدخول.");
    e.currentTarget.reset();
  }
  async function onTransfer(e){
    e.preventDefault();if(!requireLogin())return;
    const f=new FormData(e.currentTarget),recipient=String(f.get("recipient")).trim().toLowerCase(),amount=Number(f.get("amount")),note=String(f.get("note")||"");
    const {error}=await sb.rpc("transfer_wallet",{p_recipient_username:recipient,p_amount:amount,p_note:note});
    if(error){toast("تعذر التحويل: "+error.message);return}
    toast("تم تحويل الرصيد");e.currentTarget.reset();await refresh();
  }
  async function onDeposit(e){
    e.preventDefault();if(!requireLogin())return;
    const f=new FormData(e.currentTarget),amount=Number(f.get("amount")),currency=String(f.get("currency")),reference=String(f.get("reference")||"");
    const {error}=await sb.from("deposit_requests").insert({user_id:currentUser.id,amount,currency,reference,status:"pending"});
    if(error){toast("تعذر إرسال طلب الشحن: "+error.message);return}
    toast("تم إرسال طلب الشحن للمراجعة، لم تتم إضافة الرصيد بعد.");e.currentTarget.reset();
  }
  async function onAddService(e){
    e.preventDefault();if(!can("manage_services")){toast("لا تملك صلاحية إضافة الخدمات");return}
    const f=new FormData(e.currentTarget);
    const {error}=await sb.from("services").insert({name:String(f.get("name")).trim(),category:String(f.get("category")).trim(),description:String(f.get("description")||""),price:Number(f.get("price")),currency:String(f.get("currency")),is_active:true,created_by:currentUser.id});
    if(error)toast("تعذر حفظ الخدمة: "+error.message);else{toast("تمت إضافة الخدمة");e.currentTarget.reset();await loadServices()}
  }
  async function init(){
    $("#heroLogin").onclick=authOpen;$("#closeAuth").onclick=authClose;$("#authModal").onclick=e=>{if(e.target.id==="authModal")authClose()};
    $$(".tab").forEach(b=>b.onclick=()=>authTab(b.dataset.tab));$("#loginForm").addEventListener("submit",onLogin);$("#signupForm").addEventListener("submit",onSignup);
    $("#transferForm").addEventListener("submit",onTransfer);$("#depositForm").addEventListener("submit",onDeposit);$("#serviceForm").addEventListener("submit",onAddService);
    $("#logoutBtn").onclick=async()=>{await sb.auth.signOut();currentUser=null;profile=null;await refresh();toast("تم تسجيل الخروج")};
    if(!configured||!window.supabase){$("#serviceGrid").innerHTML='<div class="empty">الموقع جاهز للتهيئة: عدّل config.js بقيم مشروع Supabase، ثم نفّذ schema.sql.</div>';$("#heroLogin").onclick=()=>toast("أكمل إعداد Supabase في config.js أولاً");return}
    sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
    const {data}=await sb.auth.getSession();currentUser=data.session?.user||null;
    sb.auth.onAuthStateChange((_event,session)=>{currentUser=session?.user||null;setTimeout(()=>refresh(),0)});
    await refresh();
  }
  document.addEventListener("DOMContentLoaded",init);
})();
