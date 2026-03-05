-- Supabase SQL Setup for OSRS GE Tracker
-- Run this in the Supabase SQL editor to create all required tables

-- Visitors table (total count)
CREATE TABLE IF NOT EXISTS visitors (
    id BIGSERIAL PRIMARY KEY,
    total BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Feedback table
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('bug', 'suggestion')),
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index on created_at for faster queries
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at DESC);

-- Votes table (item up/down votes)
CREATE TABLE IF NOT EXISTS votes (
    item_id TEXT PRIMARY KEY,
    up_votes BIGINT DEFAULT 0,
    down_votes BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Highlights pending approval
CREATE TABLE IF NOT EXISTS highlights_pending (
    id TEXT PRIMARY KEY,
    player_name TEXT NOT NULL,
    caption TEXT,
    image TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index on created_at for ordering
CREATE INDEX IF NOT EXISTS highlights_pending_created_at_idx ON highlights_pending(created_at DESC);

-- Highlights approved and visible to public
CREATE TABLE IF NOT EXISTS highlights_approved (
    id TEXT PRIMARY KEY,
    player_name TEXT NOT NULL,
    caption TEXT,
    image TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    approved_date TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index on approved_date for ordering
CREATE INDEX IF NOT EXISTS highlights_approved_approved_date_idx ON highlights_approved(approved_date DESC);

-- Enable Row Level Security for extra security (optional but recommended)
-- Note: You can configure RLS policies through the Supabase dashboard
