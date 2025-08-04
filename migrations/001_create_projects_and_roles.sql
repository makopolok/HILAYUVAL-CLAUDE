-- Create the projects table
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    upload_method VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    director VARCHAR(255),
    production_company VARCHAR(255)
);

-- Create the roles table
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    playlist_id VARCHAR(255)
);S