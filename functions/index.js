const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const LINKEDIN_UGC_URL = 'https://api.linkedin.com/v2/ugcPosts';

function buildPrompt({ serviceName, audience, tone, cta }) {
  return `Generate a LinkedIn ad post for a professional laptop repair service named "${serviceName}".\n\nAudience: ${audience}.\nTone: ${tone}.\nMust include:\n1) Pain-point hook in first line\n2) 3–4 short, punchy service benefits\n3) Strong CTA\n4) 5–7 relevant hashtags\n5) Under 200 words\n6) Minimal emojis (only where useful)\n\nKey benefits to include:\n- Same-day or 24-hour turnaround\n- Expert certified technicians\n- Affordable pricing\n\nCTA target: ${cta}\n\nReturn strict JSON with fields:\n{\"hook\": string, \"post_body\": string, \"hashtags\": string[], \"total_words\": number}`;
}

function parseModelJSON(raw) {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) throw new Error('No JSON object returned by model');
  return JSON.parse(jsonMatch[0]);
}

function validatePostPayload(payload) {
  if (!payload.hook || !payload.post_body || !Array.isArray(payload.hashtags)) {
    throw new Error('Model output missing required fields');
  }

  const wordCount = Number(payload.total_words) || `${payload.hook}\n${payload.post_body}`.trim().split(/\s+/).length;
  if (wordCount > 200) {
    throw new Error(`Post exceeds 200 words (${wordCount})`);
  }

  if (payload.hashtags.length < 5 || payload.hashtags.length > 7) {
    throw new Error('Hashtag count must be between 5 and 7');
  }

  return {
    hook: payload.hook.trim(),
    post_body: payload.post_body.trim(),
    hashtags: payload.hashtags.map((h) => h.trim()),
    total_words: wordCount,
  };
}

async function generatePostWithLLM(input) {
  const openAiKey = functions.config().openai?.key;
  if (!openAiKey) {
    throw new Error('Missing Firebase config: openai.key');
  }

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            'You are a B2B LinkedIn copywriter. Write high-converting service ads for professionals and always return strict JSON only.',
        },
        { role: 'user', content: buildPrompt(input) },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('No completion content returned by model');

  return validatePostPayload(parseModelJSON(raw));
}

exports.generateLinkedInPost = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const serviceName = req.body.serviceName || 'TechFix Pro';
    const audience =
      req.body.audience || 'busy professionals, remote workers, and small business owners';
    const tone = req.body.tone || 'confident, professional, trustworthy';
    const cta = req.body.cta || 'Send us a message now to book priority service.';
    const scheduledTime = req.body.scheduledTime || null;

    const generated = await generatePostWithLLM({ serviceName, audience, tone, cta });

    const doc = await db.collection('posts').add({
      service_name: serviceName,
      audience,
      tone,
      cta,
      hook: generated.hook,
      generated_post: generated.post_body,
      hashtags: generated.hashtags,
      word_count: generated.total_words,
      status: 'draft',
      approval: {
        approved: false,
        approved_by: null,
        approved_at: null,
      },
      scheduled_time: scheduledTime ? admin.firestore.Timestamp.fromDate(new Date(scheduledTime)) : null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      published_at: null,
      linkedin_post_urn: null,
      error: null,
    });

    return res.status(200).json({ id: doc.id, ...generated, status: 'draft' });
  } catch (error) {
    console.error('generateLinkedInPost error:', error);
    return res.status(500).json({ error: error.message });
  }
});

exports.approveLinkedInPost = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { postId, approvedBy, scheduledTime } = req.body;
    if (!postId || !approvedBy) {
      return res.status(400).json({ error: 'postId and approvedBy are required' });
    }

    const ref = db.collection('posts').doc(postId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Post not found' });

    const scheduleTimestamp = scheduledTime
      ? admin.firestore.Timestamp.fromDate(new Date(scheduledTime))
      : snap.data().scheduled_time;

    await ref.update({
      status: 'scheduled',
      approval: {
        approved: true,
        approved_by: approvedBy,
        approved_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      scheduled_time: scheduleTimestamp,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      error: null,
    });

    return res.status(200).json({ postId, status: 'scheduled' });
  } catch (error) {
    console.error('approveLinkedInPost error:', error);
    return res.status(500).json({ error: error.message });
  }
});

async function publishToLinkedIn({ personUrn, accessToken, text }) {
  const payload = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: {
          text,
        },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const response = await axios.post(LINKEDIN_UGC_URL, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return response.headers['x-restli-id'] || null;
}

exports.publishScheduledLinkedInPosts = functions.pubsub
  .schedule('every 15 minutes')
  .timeZone('UTC')
  .onRun(async () => {
    const linkedinToken = functions.config().linkedin?.token;
    const linkedinPersonUrn = functions.config().linkedin?.person_urn;

    if (!linkedinToken || !linkedinPersonUrn) {
      console.error('Missing Firebase config: linkedin.token or linkedin.person_urn');
      return null;
    }

    const now = admin.firestore.Timestamp.now();
    const snapshot = await db
      .collection('posts')
      .where('status', '==', 'scheduled')
      .where('approval.approved', '==', true)
      .where('scheduled_time', '<=', now)
      .get();

    if (snapshot.empty) {
      console.log('No scheduled posts ready to publish');
      return null;
    }

    const promises = snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const finalText = `${data.hook}\n\n${data.generated_post}\n\n${(data.hashtags || []).join(' ')}`;

      try {
        const postUrn = await publishToLinkedIn({
          personUrn: linkedinPersonUrn,
          accessToken: linkedinToken,
          text: finalText,
        });

        await doc.ref.update({
          status: 'published',
          published_at: admin.firestore.FieldValue.serverTimestamp(),
          linkedin_post_urn: postUrn,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          error: null,
        });
      } catch (error) {
        console.error(`LinkedIn publish failed for ${doc.id}:`, error.message);
        await doc.ref.update({
          status: 'failed',
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          error: error.message,
        });
      }
    });

    await Promise.all(promises);
    return null;
  });
