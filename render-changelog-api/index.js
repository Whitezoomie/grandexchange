const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const API_SECRET = process.env.API_SECRET; // simple shared secret to protect admin writes

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false }
});

// GET /changelog - public read
app.get('/changelog', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('changelog')
      .select('id,title,content,date')
      .order('date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch changelog' });
  }
});

// Protect write routes by a shared API secret in header 'x-api-secret'
function requireSecret(req, res, next) {
  const header = req.get('x-api-secret');
  if (!API_SECRET || header !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// POST /changelog - add entry
app.post('/changelog', requireSecret, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!content) return res.status(400).json({ error: 'Missing content' });
    const date = Date.now();
    const { data, error } = await supabase
      .from('changelog')
      .insert([{ title: title || '', content, date }])
      .select();
    if (error) throw error;
    res.json(data && data[0] ? data[0] : {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to add changelog entry' });
  }
});

// DELETE /changelog/:id - delete entry
app.delete('/changelog/:id', requireSecret, async (req, res) => {
  try {
    const id = req.params.id;
    const { error } = await supabase
      .from('changelog')
      .delete()
      .eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete changelog entry' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Changelog API listening on ${port}`));
