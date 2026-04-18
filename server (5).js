/**
 * PizzaBoy.ai — Twilio Voice Integration
 * 
 * How it works:
 *   1. Customer calls your Twilio phone number
 *   2. Twilio hits POST /voice — we return TwiML to greet + start speech capture
 *   3. Customer speaks → Twilio transcribes → hits POST /respond
 *   4. We call Claude API with conversation history → get AI reply
 *   5. We return TwiML that speaks the reply back using text-to-speech
 *   6. Loop until customer hangs up
 *   7. On hangup, POST /complete fires — we save the transcript + extract order
 */

const express = require('express');
const twilio  = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const TWILIO_SID       = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH      = process.env.TWILIO_AUTH_TOKEN;
const BASE_URL         = process.env.BASE_URL; // e.g. https://yourapp.railway.app

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// In-memory call store (replace with a DB like Supabase/Postgres in production)
const activeCalls = new Map(); // callSid → { history, orderId, shopId, startTime, orderItems, total }

// ─── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are PizzaBoy, the friendly AI phone receptionist for Mama Rosa's Pizzeria.
You are speaking on a PHONE CALL so your responses must be:
- SHORT: 1-3 sentences max. Never long paragraphs.
- SPOKEN NATURALLY: No bullet points, no markdown, no lists. Just natural speech.
- WARM but EFFICIENT: Like a great human receptionist who values the customer's time.

RESTAURANT INFO:
- Name: Mama Rosa's Pizzeria | Hours: Mon-Thu 11am-10pm, Fri-Sat 11am-11pm, Sun 12pm-9pm
- Address: 4521 Biscayne Blvd, Miami FL | Phone: (305) 555-0192

MENU:
Pizzas: Small $11.99, Medium $14.99, Large $18.99, XL $22.99
Toppings: pepperoni, sausage, mushrooms, onions, peppers, olives, spinach, jalapeños, extra cheese (+$1.50)
Specialty: Meat Lovers $21.99, Veggie Supreme $19.99, BBQ Chicken $20.99
Sides: Garlic Knots $5.99, Caesar Salad $7.99, Mozzarella Sticks $8.99, Wings 6pc $9.99 / 12pc $16.99
Drinks: 2-Liter $2.99, Can $1.50 | Desserts: Cannoli $3.99, Tiramisu $5.99
Delivery: $3.99 under 3 miles, free over $40 | Est. 30-40 min delivery, 15-20 min pickup

UPSELL RULES:
- After taking the main order, suggest ONE add-on naturally.
- Example: "Would you like to add garlic knots for just $5.99? They're fresh out of the oven."
- If they decline, move on gracefully.

ORDER FLOW:
1. Take their order (size, toppings, quantity)
2. Offer one upsell
3. Ask: delivery or pickup?
4. If delivery: get address
5. Get their name and phone number for confirmation
6. Confirm full order + total + estimated time
7. End warmly

When the order is complete and confirmed, include this EXACT tag in your response (invisible to customer but parsed by system):
[ORDER_COMPLETE: items=<comma-separated items>, total=<dollar amount>]

POLICIES: Gluten-free crust +$3, Vegan cheese +$2, No substitutions on specialty pizzas, Catering needs 48hr notice.`;

// ─── Route: Incoming Call ─────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  const callSid   = req.body.CallSid;
  const callerNum = req.body.From || 'Unknown';
  const orderId   = uuidv4().slice(0, 8).toUpperCase();

  // Init call state
  activeCalls.set(callSid, {
    history:    [],
    orderId,
    callerNum,
    startTime:  Date.now(),
    orderItems: [],
    total:      0,
    complete:   false,
  });

  console.log(`📞 Incoming call | SID: ${callSid} | From: ${callerNum} | OrderID: ${orderId}`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Short greeting, then immediately start listening
  twiml.say({ voice: 'Polly.Joanna-Neural' },
    "Thank you for calling Mama Rosa's Pizzeria! This is PizzaBoy, your AI assistant. How can I help you today?"
  );

  twiml.gather({
    input:        'speech',
    action:       `${BASE_URL}/respond`,
    method:       'POST',
    speechTimeout: 'auto',
    speechModel:  'phone_call',
    language:     'en-US',
  });

  // If no input after gather, re-prompt
  twiml.redirect(`${BASE_URL}/no-input`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─── Route: Process Speech & Respond ─────────────────────────────────────────
app.post('/respond', async (req, res) => {
  const callSid     = req.body.CallSid;
  const speechText  = req.body.SpeechResult || '';
  const confidence  = parseFloat(req.body.Confidence || 0);

  console.log(`🗣️  [${callSid}] Customer said: "${speechText}" (confidence: ${(confidence * 100).toFixed(0)}%)`);

  const call = activeCalls.get(callSid);
  const twiml = new twilio.twiml.VoiceResponse();

  // Low confidence — ask to repeat
  if (!speechText || confidence < 0.4) {
    twiml.say({ voice: 'Polly.Joanna-Neural' }, "I'm sorry, I didn't catch that. Could you say that again?");
    twiml.gather({
      input:        'speech',
      action:       `${BASE_URL}/respond`,
      method:       'POST',
      speechTimeout: 'auto',
      speechModel:  'phone_call',
    });
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Add to history
  call.history.push({ role: 'user', content: speechText });

  try {
    const aiResponse = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 300, // keep it short for phone
      system:     SYSTEM_PROMPT,
      messages:   call.history,
    });

    let replyText = aiResponse.content.map(b => b.type === 'text' ? b.text : '').join('');

    // Check for order complete tag
    const orderMatch = replyText.match(/\[ORDER_COMPLETE:\s*items=([^,\]]+(?:,[^=\]]+)*),\s*total=\$?([\d.]+)\]/);
    if (orderMatch) {
      call.complete   = true;
      call.orderItems = orderMatch[1].split(',').map(s => s.trim());
      call.total      = parseFloat(orderMatch[2]);
      replyText       = replyText.replace(/\[ORDER_COMPLETE:[^\]]+\]/, '').trim();
      console.log(`✅ Order complete! Items: ${call.orderItems.join(', ')} | Total: $${call.total}`);
      logOrder(callSid, call);
    }

    // Add assistant reply to history
    call.history.push({ role: 'assistant', content: replyText });

    console.log(`🤖 [${callSid}] AI replied: "${replyText.slice(0, 80)}..."`);

    twiml.say({ voice: 'Polly.Joanna-Neural' }, replyText);

    if (call.complete) {
      // Order done — say goodbye and hang up
      twiml.say({ voice: 'Polly.Joanna-Neural' },
        "Thanks for calling Mama Rosa's! We'll see you soon. Goodbye!"
      );
      twiml.hangup();
    } else {
      // Keep listening
      twiml.gather({
        input:        'speech',
        action:       `${BASE_URL}/respond`,
        method:       'POST',
        speechTimeout: 'auto',
        speechModel:  'phone_call',
      });
      twiml.redirect(`${BASE_URL}/no-input`);
    }

  } catch (err) {
    console.error(`❌ Claude API error:`, err.message);
    twiml.say({ voice: 'Polly.Joanna-Neural' },
      "I'm having a little trouble right now. Please hold while I transfer you to the team."
    );
    // Fallback: transfer to real staff
    if (process.env.FALLBACK_PHONE) {
      twiml.dial(process.env.FALLBACK_PHONE);
    } else {
      twiml.hangup();
    }
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─── Route: No Input / Silence ────────────────────────────────────────────────
app.post('/no-input', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' },
    "I didn't hear anything. Are you still there? Go ahead and tell me what you'd like to order."
  );
  twiml.gather({
    input:        'speech',
    action:       `${BASE_URL}/respond`,
    method:       'POST',
    speechTimeout: 'auto',
    speechModel:  'phone_call',
  });
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ─── Route: Call Complete (Twilio Status Callback) ───────────────────────────
app.post('/complete', (req, res) => {
  const callSid    = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const duration   = req.body.CallDuration;
  const call       = activeCalls.get(callSid);

  if (call) {
    console.log(`📴 Call ended | SID: ${callSid} | Status: ${callStatus} | Duration: ${duration}s`);
    console.log(`   Turns: ${call.history.length / 2} | Order complete: ${call.complete} | Total: $${call.total}`);

    // TODO: Save full transcript to your database here
    // await db.saveCall({ callSid, ...call, duration, callStatus });

    activeCalls.delete(callSid);
  }
  res.sendStatus(200);
});

// ─── Route: Dashboard API — Recent Calls ─────────────────────────────────────
app.get('/api/calls', (req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([sid, c]) => ({
    sid,
    orderId:    c.orderId,
    callerNum:  c.callerNum,
    turns:      Math.floor(c.history.length / 2),
    total:      c.total,
    complete:   c.complete,
    duration:   Math.floor((Date.now() - c.startTime) / 1000),
  }));
  res.json({ activeCalls: calls.length, calls });
});

// ─── Route: Health Check ──────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'PizzaBoy.ai', uptime: process.uptime() });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function logOrder(callSid, call) {
  const order = {
    id:        call.orderId,
    callSid,
    callerNum: call.callerNum,
    items:     call.orderItems,
    total:     call.total,
    timestamp: new Date().toISOString(),
  };
  console.log('🍕 NEW ORDER:', JSON.stringify(order, null, 2));

  // TODO: Hook into your POS system here
  // await toast.createOrder(order);
  // await square.createOrder(order);
  // await sendSMS(call.callerNum, `Your order #${order.id} is confirmed! ~30-40 min. Thank you!`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
🍕 PizzaBoy.ai Twilio Server running on port ${PORT}
   POST ${BASE_URL || 'http://localhost:'+PORT}/voice        ← Set as Twilio Voice webhook
   POST ${BASE_URL || 'http://localhost:'+PORT}/complete     ← Set as Twilio Status callback
   GET  ${BASE_URL || 'http://localhost:'+PORT}/health       ← Health check
   GET  ${BASE_URL || 'http://localhost:'+PORT}/api/calls    ← Active calls API
  `);
});

module.exports = app;
