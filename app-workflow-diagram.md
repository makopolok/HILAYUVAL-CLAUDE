# Hila Yuval Casting Platform - Application Workflow Diagram

## Overview
This is a casting management platform that allows casting directors to create projects and receive audition submissions from actors.

## Application Architecture

```mermaid
graph TD
    %% User Types
    A[Casting Director] --> B[Create Project Form]
    C[Actor] --> D[Audition Form]
    
    %% Project Creation Flow
    B --> E[Project Creation Handler<br>/projects/create POST]
    E --> F{Upload Method?}
    F -->|YouTube| G[Create YouTube Playlists<br>for each role]
    F -->|Cloudflare| H[Use Cloudflare Storage]
    G --> I[Save Project to PostgreSQL]
    H --> I
    I --> J[Send Email Notification]
    J --> K[Project Success Page<br>with Audition URLs]
    
    %% Audition Submission Flow
    D --> L[Audition Handler<br>/audition/:projectId POST]
    L --> M[Validate Form Data]
    M --> N[Process File Uploads]
    N --> O{Video Upload Method?}
    O -->|YouTube| P[Upload to YouTube<br>Add to Role Playlist]
    O -->|Cloudflare| Q[Upload to Cloudflare Stream]
    P --> R[Save Audition to PostgreSQL]
    Q --> R
    R --> S[Audition Success Page<br>with Video Player]
    
    %% Management Views
    K --> T[All Projects View<br>/projects]
    T --> U[Individual Project Auditions<br>/projects/:id/auditions]
    U --> V[Video Playback<br>Cloudflare Stream Player]
    
    %% Portfolio/Home
    W[Public Portfolio<br>/] --> X[Home Page<br>Hila's Work Display]
    
    %% Database Layer
    I --> Y[(PostgreSQL Database)]
    R --> Y
    Y --> Z[Tables:<br>- projects<br>- roles<br>- auditions]
    
    %% External Services
    G --> AA[Google YouTube API]
    Q --> BB[Cloudflare Stream API]
    J --> CC[SMTP Email Service]
```

## Database Schema

```mermaid
erDiagram
    projects {
        text id PK
        text name
        text description
        text upload_method
        timestamp created_at
        text director
        text production_company
    }
    
    roles {
        serial id PK
        text project_id FK
        text name
        text playlist_id
    }
    
    auditions {
        serial id PK
        text project_id FK
        text role
        text first_name_he
        text last_name_he
        text first_name_en
        text last_name_en
        text phone
        text email
        text agency
        integer age
        integer height
        jsonb profile_pictures
        text showreel_url
        text video_url
        text video_type
        timestamp created_at
    }
    
    projects ||--o{ roles : "has"
    projects ||--o{ auditions : "receives"
```

## Key Application Routes

### Public Routes
- `GET /` - Portfolio/Home page displaying Hila's work
- `GET /audition/:projectId` - Project-specific audition form
- `POST /audition/:projectId` - Submit audition for specific project

### Management Routes
- `GET /projects/create` - Create new casting project form
- `POST /projects/create` - Handle project creation
- `GET /projects` - List all projects with search/filter
- `GET /projects/:id/edit` - Edit project details
- `POST /projects/:id/add-role` - Add new role to project
- `GET /projects/:id/auditions` - View all auditions for project

### Authentication Routes
- `GET /auth/google` - Initiate Google OAuth for YouTube
- `GET /oauth2callback` - Handle OAuth callback

## Technology Stack

### Backend
- **Node.js/Express** - Web server framework
- **PostgreSQL** - Primary database (Heroku Postgres)
- **Handlebars** - Template engine
- **Multer** - File upload handling

### External Services
- **Google YouTube API** - Video upload and playlist management
- **Cloudflare Stream** - Video hosting and streaming
- **Nodemailer/SMTP** - Email notifications
- **Heroku** - Cloud hosting platform

### Frontend
- **Bootstrap 5** - CSS framework
- **Handlebars templates** - Server-side rendering
- **Custom CSS** - Red-themed styling for Hila's brand

## Key Features

1. **Dual Video Upload Methods**
   - YouTube: Public playlists for each role
   - Cloudflare Stream: Private video hosting

2. **Multi-language Support**
   - Hebrew and English name fields
   - Right-to-left text support

3. **File Management**
   - Profile picture uploads via Cloudflare Images
   - Video file processing and upload to Cloudflare Stream or YouTube

4. **Search and Filtering**
   - Search auditions by name, email, role
   - Filter across all projects

5. **Responsive Design**
   - Mobile-friendly audition forms
   - Video player with loading states

## Error Handling
- Comprehensive try-catch blocks
- Custom error handler middleware
- Detailed logging for debugging
- Graceful fallbacks for API failures

## Deployment
- Heroku cloud platform
- Environment-based configuration
- Database migrations support
- Custom deployment scripts
