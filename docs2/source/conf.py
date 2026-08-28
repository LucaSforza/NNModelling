import os
import sys

sys.path.insert(0, os.path.abspath('../../converted/src'))

autodoc_mock_imports = [
    'torch',
    'torchvision',
    'lightning',
    'torchmetrics',
    'datasets',
    'transformers',
    'wandb',
]

project = 'NNModelling'
copyright = '2026, Luca Sforza'
author = 'Luca Sforza'
release = '0.1.0'

extensions = [
    'sphinx.ext.autodoc',
    'sphinx.ext.napoleon',
    'sphinx.ext.viewcode',
    'sphinx.ext.mathjax',
    'sphinx.ext.todo',
    'sphinx.ext.intersphinx',
    'sphinx_autodoc_typehints',
]

templates_path = ['_templates']
exclude_patterns = []

language = 'en'

html_theme = 'sphinx_rtd_theme'
html_static_path = ['_static']

intersphinx_mapping = {
    'python': ('https://docs.python.org/3', None),
    'torch': ('https://pytorch.org/docs/stable', None),
    'lightning': ('https://lightning.ai/docs/pytorch/stable', None),
}

autodoc_member_order = 'bysource'
autodoc_typehints = 'description'
napoleon_google_docstring = True
napoleon_numpy_docstring = False
todo_include_todos = True
